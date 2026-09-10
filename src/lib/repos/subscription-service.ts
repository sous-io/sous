/**
 * The subscription service: the workflow the consumer commands drive.
 *
 * Everything underneath it is a single-purpose part (a provider, the index
 * cache, the resolver, the trust layer, the store, the lockfile). This is the
 * one place that puts them in the right order, and the order is the design:
 *
 *   - Nothing is fetched from a repository before it is trusted, not even its
 *     index. `addRepo` runs the trust ceremony first and fetches second.
 *   - Resolution is iterative. Each round may turn up repositories a dependency
 *     needs that the project has not added; those go through one consolidated
 *     trust question and the round runs again.
 *   - A subscription is not finished until its questions are answered, so
 *     `subscribe` ends by asking for the variables its recipes publish.
 *   - Restoring never decides anything: it fetches exactly what the lockfile
 *     pins, which is what makes a fresh clone reproducible and prompt-free.
 *
 * Every collaborator is injectable, so a test can drive the whole workflow
 * against a local fixture repository without a network.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { ConfigError, isConfigError } from "../errors.js";
import type { Settings } from "../settings.js";
import { CONFD_DIR_NAME } from "../config-discovery.js";
import { warning } from "../../utils/formatting.js";
import { isInteractive } from "../../utils/prompts.js";
import {
  askForMissing,
  loadLadderContext,
  type AskReport,
  type DefinedVariable,
  type DefiningRecipe,
} from "../vars/index.js";
import type { IndexFile } from "./formats/index-file.js";
import {
  PROJECT_HOLDER,
  type LockedRecipe,
  type Lockfile,
} from "./formats/lockfile.js";
import type { RecipeManifest } from "./formats/recipe-manifest.js";
import { formatRef, parseRef, refKey, type ParsedRef } from "./ref.js";
import {
  PROJECT_REQUESTER,
  resolveRefs,
  type ResolvedRecipe,
  type ResolverRepo,
} from "./resolver.js";
import { LockService, type LockDiff, type RestoreReport } from "./lock-service.js";
import { TrustService, USER_ADDED_BY, type TrustedRepo } from "./trust.js";
import {
  SUBSCRIPTIONS_LAYER_FILENAME,
  readManagedLayer,
  removeManagedLayer,
  writeManagedLayer,
} from "./managed-layer.js";
import {
  builtInProviders,
  createIndexCache,
  requireProvider,
  type IndexCache,
  type ProviderOptions,
  type ProviderId,
  type RepoProvider,
} from "./providers/index.js";
import { normalizeRepoUrl } from "./providers/provider.js";
import { RecipeStore } from "./store/recipe-store.js";
import type { RecipeStoreLike, StoreKey } from "./store/contract.js";
import { resolveStoreSettings } from "./store/settings.js";
import { findNewerInRange, recordUpstreamCheck, shouldCheckUpstream } from "./freshness.js";
import { REPO_NAME_PATTERN } from "./formats/patterns.js";
import { linkedPathFor } from "./links.js";
import { listLockedRecipes, mapLinkedRecipes, readRecipeManifestIn } from "./locked-recipes.js";
import { resolveStoreRoot } from "../sous-home.js";

// --- Options and reports ------------------------------------------------------------------------

/** How the subscription service is built. Every collaborator is injectable. */
export type SubscriptionServiceOptions = {
  /** The project's `.sous/` directory: lockfile, links map and env files. */
  sousDir: string;
  /** The project's `conf.d/` directory. Defaults to `<sousDir>/conf.d`. */
  confDir?: string;
  /** The merged project config. */
  settings: Settings;
  /** The environment to read; decides where the store is. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * The real shell environment, snapshotted before the `.sous/` env files were
   * injected. Used only to tell a shell-supplied answer from a file-supplied one.
   */
  shellEnv?: NodeJS.ProcessEnv;
  /** Whether sous may ask questions. Defaults to whether both streams are a terminal. */
  interactive?: boolean;
  /** The recipe store. Defaults to the machine-wide one. */
  store?: RecipeStoreLike;
  /** The index cache. Defaults to one rooted at the store. */
  indexCache?: IndexCache;
  /** The trust layer. Defaults to one bound to this project. */
  trust?: TrustService;
  /** The lockfile service. Defaults to one bound to this project. */
  lock?: LockService;
  /** The providers to choose from. Defaults to the built-ins. */
  providers?: RepoProvider[];
  /** Options handed to every provider call. */
  providerOptions?: ProviderOptions;
  /** Where warnings go. Defaults to the console warning banner. */
  warn?: (message: string) => void;
  /** The clock, so a recorded timestamp is predictable in tests. */
  now?: () => Date;
};

/** What `addRepo` is asked to do. */
export type AddRepoOptions = {
  /** The repository's URL, or an absolute path for one on this machine. */
  url: string;
  /** The short name refs will use. Defaults to the last segment of the URL. */
  name?: string;
  /** The provider that handles it, when the URL does not give it away. */
  provider?: ProviderId;
  /** Acknowledge trust without being asked, for a run with no terminal. */
  trust?: boolean;
  /** Work out what would happen and report it, writing and fetching nothing. */
  dryRun?: boolean;
};

/** What `addRepo` did. */
export type AddRepoOutcome = {
  /** The short name the repository was recorded under. */
  name: string;
  /** Where it lives, as recorded. */
  url: string;
  /** The provider that handles it. */
  provider: ProviderId;
  /** True when the project already trusted this exact repository. */
  alreadyTrusted: boolean;
  /** Every namespace its index declares, sorted. */
  namespaces: string[];
  /** How many recipes its index publishes. */
  recipeCount: number;
  /** True when nothing was written, because this was a dry run. */
  dryRun: boolean;
};

/** What `subscribe` is asked to do. */
export type SubscribeOptions = {
  /** The ref to subscribe to: a namespace, or `namespace/recipe`, with an optional range. */
  ref: string;
  /** Let prerelease versions take part in range matching. */
  prerelease?: boolean;
  /** Prefer a newer in-range version over the locked one on every build. */
  alwaysPull?: boolean;
  /** Acknowledge trust for every repository this command adds, without being asked. */
  trust?: boolean;
  /** Work out what would happen and report it, writing and fetching nothing. */
  dryRun?: boolean;
};

/** What `subscribe` did. */
export type SubscribeOutcome = {
  /** The ref, in its canonical written form. */
  ref: string;
  /** The key the subscription was recorded under. */
  key: string;
  /** Every recipe version the resolution settled on. */
  resolved: ResolvedRecipe[];
  /** Repositories that had to be trusted along the way. */
  trusted: string[];
  /** What changed in the lockfile. */
  diff: LockDiff;
  /** What the variable questions produced, when they were asked. */
  answers?: AskReport;
  /** Dependency cycles the resolver noticed, reported rather than treated as fatal. */
  cycles: string[][];
  /** True when nothing was written, because this was a dry run. */
  dryRun: boolean;
};

/** What `unsubscribe` is asked to do. */
export type UnsubscribeOptions = {
  /** The ref to unsubscribe from. */
  ref: string;
  /** Work out what would happen and report it, writing nothing. */
  dryRun?: boolean;
};

/** What `unsubscribe` did. */
export type UnsubscribeOutcome = {
  /** The key the subscription was recorded under. */
  key: string;
  /** What changed in the lockfile. */
  diff: LockDiff;
  /** Recipes that stayed because something else still holds them, with who holds them. */
  stayed: Array<{ key: string; heldBy: string[] }>;
  /** True when nothing was written, because this was a dry run. */
  dryRun: boolean;
};

/** What an upstream check found. */
export type UpstreamCheckReport = {
  /** Repositories that were actually asked. */
  checked: string[];
  /** Recipes moved to a newer in-range version. */
  updated: Array<{ key: string; from: string; to: string }>;
  /** Repositories whose check failed; the last good answer still stands. */
  failed: Array<{ repo: string; reason: string }>;
};

// --- The service --------------------------------------------------------------------------------

/** Adds repositories, subscribes to recipes, and keeps the store and lockfile honest. */
export class SubscriptionService {
  private readonly sousDir: string;

  private readonly confDir: string;

  private readonly settings: Settings;

  private readonly env: NodeJS.ProcessEnv;

  private readonly shellEnv: NodeJS.ProcessEnv;

  private readonly interactive: boolean;

  private readonly providers: RepoProvider[];

  private readonly providerOptions: ProviderOptions;

  private readonly warn: (message: string) => void;

  private readonly now: () => Date;

  private readonly storeInstance: RecipeStoreLike;

  private readonly indexCache: IndexCache;

  private readonly trust: TrustService;

  private readonly lock: LockService;

  /**
   * @param options - The project's directories, its config, and any collaborator to override.
   */
  constructor(options: SubscriptionServiceOptions) {
    this.sousDir = options.sousDir;
    this.confDir = options.confDir ?? path.join(options.sousDir, CONFD_DIR_NAME);
    this.settings = options.settings;
    this.env = options.env ?? process.env;
    this.shellEnv = options.shellEnv ?? this.env;
    this.interactive = options.interactive ?? isInteractive();
    this.providers = options.providers ?? builtInProviders();
    this.providerOptions = options.providerOptions ?? {};
    this.warn = options.warn ?? warning;
    this.now = options.now ?? (() => new Date());

    this.storeInstance =
      options.store ??
      new RecipeStore({ root: resolveStoreRoot(this.env), onWarning: this.warn });
    this.indexCache =
      options.indexCache ??
      createIndexCache({
        storeRoot: this.storeInstance.root,
        resolveProvider: (url, providerId) =>
          requireProvider(url, providerId, this.providers),
        providerOptions: this.providerOptions,
        warn: this.warn,
        now: this.now,
      });
    this.trust =
      options.trust ??
      new TrustService({
        sousDir: this.sousDir,
        confDir: this.confDir,
        settings: this.settings,
        interactive: this.interactive,
        now: this.now,
      });
    this.lock = options.lock ?? new LockService(this.sousDir);
  }

  /** The recipe store this service fills and reads. */
  get store(): RecipeStoreLike {
    return this.storeInstance;
  }

  /** The lockfile service this project uses. */
  get lockService(): LockService {
    return this.lock;
  }

  // --- Adding a repository ----------------------------------------------------------------------

  /**
   * Adds a repository, which is the same thing as trusting it, and then fetches
   * exactly one file from it: its index. Nothing is downloaded before the trust
   * question is answered.
   *
   * @param options - The URL, an optional short name and provider, and the trust flag.
   */
  async addRepo(options: AddRepoOptions): Promise<AddRepoOutcome> {
    const url = options.url.trim();
    const provider = requireProvider(url, options.provider, this.providers);
    const canonical = provider.canonicalize(url);
    const name = options.name ?? canonical.name;

    if (!REPO_NAME_PATTERN.test(name)) {
      throw new ConfigError(
        `'${name}' is not a usable short name for a repository.\n` +
          `  A short name is lowercase kebab-case: a letter, then letters, digits or ` +
          `hyphens. It is what refs use as the 'repo:' qualifier.\n` +
          `  Choose one with '--name', for example ` +
          `'sous repo add ${url} --name my-recipes'.`
      );
    }

    const existing = this.currentRepos()[name];
    const alreadyTrusted =
      existing !== undefined && normalizeRepoUrl(existing.url) === normalizeRepoUrl(url);

    if (existing !== undefined && !alreadyTrusted) {
      throw new ConfigError(
        `This project already has a repository called '${name}', and it is a different one.\n` +
          `  Already added: ${existing.url}\n` +
          `  Being added:   ${url}\n` +
          `  Give this one a name of its own with '--name', for example ` +
          `'sous repo add ${url} --name ${name}-2'.`
      );
    }

    if (options.dryRun === true) {
      return {
        name,
        url,
        provider: provider.id,
        alreadyTrusted,
        namespaces: [],
        recipeCount: 0,
        dryRun: true,
      };
    }

    // Trust first, fetch second. This is the last gate before a repository's
    // recipes can put files (and scripts) on this machine.
    if (!alreadyTrusted) {
      await this.trust.confirmTrust(
        [
          {
            name,
            url,
            requiredBy: [{ ref: name, requestedBy: PROJECT_REQUESTER }],
          },
        ],
        {
          interactive: this.interactive,
          ...(options.trust === undefined ? {} : { trustFlag: options.trust }),
        }
      );
    }

    // Written again even when confirmTrust already wrote it, so the entry records
    // that a person added this repository deliberately rather than a dependency
    // having dragged it in.
    this.trust.addRepo({
      name,
      url,
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      addedBy: USER_ADDED_BY,
    });

    const lookup = await this.indexCache.getIndex(name, {
      url,
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      force: true,
    });

    return {
      name,
      url,
      provider: provider.id,
      alreadyTrusted,
      namespaces: Object.keys(lookup.index.namespaces).sort(),
      recipeCount: Object.keys(lookup.index.recipes).length,
      dryRun: false,
    };
  }

  // --- Subscribing ------------------------------------------------------------------------------

  /**
   * Subscribes the project to a namespace or a recipe: resolves the whole
   * dependency closure, trusts whatever new repositories that turns up, fetches
   * every resolved version into the store, writes the lockfile and the managed
   * subscriptions layer, and finally asks for the variables the new recipes
   * publish.
   *
   * @param options - The ref, the prerelease and always-pull flags, and the trust flag.
   */
  async subscribe(options: SubscribeOptions): Promise<SubscribeOutcome> {
    const parsed = parseRef(options.ref);
    const key = refKey(parsed);
    const dryRun = options.dryRun === true;

    const { resolved, trusted, cycles } = await this.resolveClosure(parsed, options);

    const before = this.lock.read();
    const after = this.lock.applyResolution(before, resolved, this.lockRepoInputs());
    const diff = this.lock.diff(before, after);

    if (dryRun) {
      return { ref: formatRef(parsed), key, resolved, trusted, diff, cycles, dryRun: true };
    }

    for (const recipe of resolved) await this.ensureStored(recipe);

    this.lock.write(after);
    this.writeSubscriptionEntry(key, parsed, options);

    const answers = await this.askVariables(resolved);

    return { ref: formatRef(parsed), key, resolved, trusted, diff, answers, cycles, dryRun: false };
  }

  /**
   * Resolves a ref and everything beneath it, running the trust round as often
   * as resolution keeps turning up repositories the project has not added.
   *
   * @param parsed - The ref being subscribed to.
   * @param options - The prerelease and trust flags.
   */
  private async resolveClosure(
    parsed: ParsedRef,
    options: SubscribeOptions
  ): Promise<{ resolved: ResolvedRecipe[]; trusted: string[]; cycles: string[][] }> {
    const trusted: string[] = [];

    for (;;) {
      const repos = this.resolverRepos();
      const indexes = await this.loadIndexes(Object.keys(repos));

      const result = await resolveRefs(
        [
          {
            ref: parsed,
            requestedBy: PROJECT_REQUESTER,
            kind: "subscribes",
            ...(options.prerelease === true ? { prerelease: true } : {}),
          },
        ],
        {
          indexes,
          repos,
          loadManifest: (recipe) => this.loadRecipeManifest(recipe, options.dryRun === true),
          ...(options.prerelease === true ? { prerelease: true } : {}),
        }
      );

      if (result.missingRepos.length === 0) {
        if (result.missingManifests.length > 0) {
          throw new ConfigError(
            `Sous could not read the manifest of ` +
              `${result.missingManifests.map((entry) => `'${entry}'`).join(", ")}.\n` +
              `  Every recipe carries a manifest, so this one is either damaged upstream ` +
              `or could not be downloaded. Nothing was written.`
          );
        }
        return { resolved: result.resolved, trusted, cycles: result.cycles };
      }

      const outcome = await this.trust.confirmTrust(result.missingRepos, {
        interactive: this.interactive,
        ...(options.trust === undefined ? {} : { trustFlag: options.trust }),
      });

      if (outcome.needUrl.length > 0) {
        const lines = [
          outcome.needUrl.length === 1
            ? `Sous does not know where the repository '${outcome.needUrl[0]}' lives, so it ` +
              `cannot add it for you.`
            : `Sous does not know where these repositories live, so it cannot add them for ` +
              `you: ${outcome.needUrl.map((entry) => `'${entry}'`).join(", ")}.`,
          "  A recipe names the repository it depends on by its short name only; the URL " +
            "has to come from you.",
          "  Add each one with its URL, then run this command again:",
          "",
        ];
        for (const name of outcome.needUrl) {
          lines.push(`    sous repo add <url> --name ${name}`);
        }
        throw new ConfigError(lines.join("\n"));
      }

      trusted.push(...outcome.added);
    }
  }

  /**
   * Removes one subscription and everything that was only there because of it.
   * Removal is refcounted: a recipe another subscription (or another recipe)
   * still holds stays exactly where it is, and is reported as having stayed.
   *
   * @param options - The ref to unsubscribe from.
   */
  async unsubscribe(options: UnsubscribeOptions): Promise<UnsubscribeOutcome> {
    const parsed = parseRef(options.ref);
    const key = refKey(parsed);
    const dryRun = options.dryRun === true;

    const managed = this.readSubscriptionEntries();
    const configured = this.settings.subscriptions ?? {};
    const before = this.lock.read();
    const held = this.keysHeldBySubscription(before, key);

    if (!Object.hasOwn(managed, key) && !Object.hasOwn(configured, key) && held.length === 0) {
      const known = [...new Set([...Object.keys(managed), ...Object.keys(configured)])].sort();
      throw new ConfigError(
        `This project does not subscribe to '${key}'.\n` +
          (known.length > 0
            ? `  It subscribes to: ${known.join(", ")}.`
            : `  It has no subscriptions yet.`)
      );
    }

    if (!Object.hasOwn(managed, key) && Object.hasOwn(configured, key)) {
      throw new ConfigError(
        `The subscription to '${key}' is written in this project's own config, not in the ` +
          `layer sous manages.\n` +
          `  Remove its entry from the 'subscriptions' block of your config file; sous ` +
          `never edits a config file you wrote.`
      );
    }

    let after = before;
    for (const heldKey of held) after = this.dropProjectHold(after, heldKey);
    const diff = this.lock.diff(before, after);

    const stayed = held
      .filter((heldKey) => Object.hasOwn(after.recipes, heldKey))
      .map((heldKey) => ({
        key: heldKey,
        heldBy: [...after.recipes[heldKey]!.requestedBy],
      }));

    if (!dryRun) {
      this.lock.write(after);

      const remaining = { ...managed };
      delete remaining[key];
      if (Object.keys(remaining).length === 0) {
        removeManagedLayer(this.sousDir, SUBSCRIPTIONS_LAYER_FILENAME, {
          confDir: this.confDir,
        });
      } else {
        writeManagedLayer(
          this.sousDir,
          SUBSCRIPTIONS_LAYER_FILENAME,
          { subscriptions: remaining },
          { confDir: this.confDir }
        );
      }
    }

    return { key, diff, stayed, dryRun };
  }

  // --- Restoring and upstream checks -------------------------------------------------------------

  /**
   * True when the lockfile pins something the store does not hold, which is the
   * state of a fresh clone. A linked repository is read from its checkout and is
   * never restored.
   */
  needsRestore(): boolean {
    return listLockedRecipes({ sousDir: this.sousDir, env: this.env }).some(
      (recipe) => !recipe.linked && !recipe.present
    );
  }

  /**
   * Makes the store hold exactly what the lockfile pins. Nothing here decides a
   * version and nothing here asks a question; that is what makes a fresh clone
   * reproducible.
   */
  async restore(): Promise<RestoreReport> {
    const lock = this.lock.read();
    if (Object.keys(lock.recipes).length === 0) {
      return { restored: [], alreadyPresent: [] };
    }

    const indexes = await this.loadIndexes(Object.keys(lock.repos), { lock });
    return this.lock.restore(lock, {
      store: this.storeInstance,
      indexes,
      providers: this.providers,
      providerOptions: this.providerOptions,
    });
  }

  /**
   * Looks upstream for the repositories that prefer a newer in-range version,
   * and moves the lockfile to it when there is one. A failed check never breaks
   * a build: it is warned about and the last good answer stands.
   *
   * @param options - Whether to check regardless of the freshness window, and which window to use.
   */
  async checkUpstream(
    options: { force?: boolean; freshnessSeconds?: number } = {}
  ): Promise<UpstreamCheckReport> {
    const report: UpstreamCheckReport = { checked: [], updated: [], failed: [] };
    const lock = this.lock.read();
    if (Object.keys(lock.recipes).length === 0) return report;

    const storeSettings = resolveStoreSettings(this.settings);
    const freshnessSeconds = options.freshnessSeconds ?? storeSettings.freshnessSeconds;
    const repos = this.currentRepos();
    const subscriptions = this.allSubscriptions();

    let changed = false;
    const recipes: Record<string, LockedRecipe> = { ...lock.recipes };

    for (const repoName of Object.keys(lock.repos).sort()) {
      if (!this.prefersNewer(repoName, repos[repoName], lock, subscriptions)) continue;

      const meta = this.indexCache.readMeta(repoName);
      const due = shouldCheckUpstream({
        ...(meta?.lastCheckedAt === undefined ? {} : { lastCheckedAt: meta.lastCheckedAt }),
        freshnessSeconds,
        alwaysPull: true,
        ...(options.force === undefined ? {} : { force: options.force }),
        now: this.now(),
      });
      if (!due) continue;

      report.checked.push(repoName);

      let index: IndexFile;
      try {
        const url = repos[repoName]?.url ?? lock.repos[repoName]!.url;
        const providerId = repos[repoName]?.provider;
        index = (
          await this.indexCache.getIndex(repoName, {
            url,
            ...(providerId === undefined ? {} : { provider: providerId }),
            force: true,
          })
        ).index;
      } catch (error) {
        report.failed.push({ repo: repoName, reason: describeError(error) });
        // Recorded even though it failed, so an unreachable host is not retried
        // on every single build.
        recordUpstreamCheck(this.indexCache, repoName, this.now());
        continue;
      }

      recordUpstreamCheck(this.indexCache, repoName, this.now());

      for (const [key, entry] of Object.entries(recipes)) {
        if (entry.repo !== repoName) continue;
        const subscription = subscriptions[key] ?? subscriptions[key.split("/")[0]!];
        const newer = findNewerInRange({
          index,
          key,
          lockedVersion: entry.version,
          ...(subscription?.range === undefined ? {} : { range: subscription.range }),
          ...(subscription?.prerelease === undefined
            ? {}
            : { prerelease: subscription.prerelease }),
        });
        if (newer === undefined) continue;

        const published = index.recipes[key]!.versions[newer.to]!;
        try {
          await this.fetchIntoStore({
            repo: repoName,
            key,
            version: newer.to,
            hash: published.hash,
            tag: published.tag,
            recipePath: index.recipes[key]!.path,
            url: repos[repoName]?.url ?? lock.repos[repoName]!.url,
            providerId: repos[repoName]?.provider,
          });
        } catch (error) {
          report.failed.push({ repo: repoName, reason: describeError(error) });
          continue;
        }

        recipes[key] = { ...entry, version: newer.to, hash: published.hash };
        report.updated.push(newer);
        changed = true;
      }
    }

    if (changed) this.lock.write({ ...lock, recipes });
    return report;
  }

  /**
   * Everything a build needs done before it compiles: restore whatever the store
   * is missing, then look upstream for the repositories that want a newer
   * version. Both are quiet when there is nothing to do.
   *
   * @param options - Whether to force the upstream check, and which freshness window to use.
   */
  async prepareForBuild(
    options: { force?: boolean; freshnessSeconds?: number } = {}
  ): Promise<{ restored: RestoreReport | undefined; upstream: UpstreamCheckReport }> {
    let restored: RestoreReport | undefined;
    if (this.needsRestore()) restored = await this.restore();
    const upstream = await this.checkUpstream(options);
    return { restored, upstream };
  }

  // --- Reading the project's state ---------------------------------------------------------------

  /**
   * Every repository this project trusts, merging the config it was loaded with
   * and the managed layer as it stands on disk right now. The layer is re-read
   * because a trust round in this same process may have just written to it.
   */
  currentRepos(): Record<string, TrustedRepo> {
    return {
      ...((this.settings.repos ?? {}) as Record<string, TrustedRepo>),
      ...this.trust.listManaged(),
    };
  }

  /** Every subscription, from the config and from the managed layer. */
  allSubscriptions(): Record<string, SubscriptionEntry> {
    return {
      ...((this.settings.subscriptions ?? {}) as Record<string, SubscriptionEntry>),
      ...this.readSubscriptionEntries(),
    };
  }

  /** The trusted repositories in the shape the resolver reads. */
  private resolverRepos(): Record<string, ResolverRepo> {
    const repos: Record<string, ResolverRepo> = {};
    for (const [name, entry] of Object.entries(this.currentRepos())) {
      repos[name] = {
        url: entry.url,
        ...(entry.provider === undefined ? {} : { provider: entry.provider }),
        ...(entry.alwaysPull === undefined ? {} : { alwaysPull: entry.alwaysPull }),
      };
    }
    return repos;
  }

  /** The repository records the lockfile writes, keyed by short name. */
  private lockRepoInputs(): Record<string, { url: string }> {
    const inputs: Record<string, { url: string }> = {};
    for (const [name, entry] of Object.entries(this.currentRepos())) {
      inputs[name] = { url: entry.url };
    }
    return inputs;
  }

  /**
   * The cached (or freshly fetched) index of each named repository. A repository
   * whose index cannot be obtained at all is warned about and left out, so one
   * unreachable host never blocks work on the others.
   *
   * @param names - The repositories to load indexes for.
   * @param options - A lockfile to fall back to for a repository's URL.
   */
  async loadIndexes(
    names: string[],
    options: { lock?: Lockfile; force?: boolean } = {}
  ): Promise<Map<string, IndexFile>> {
    const repos = this.currentRepos();
    const indexes = new Map<string, IndexFile>();
    const freshnessSeconds = resolveStoreSettings(this.settings).freshnessSeconds;

    for (const name of names) {
      const url = repos[name]?.url ?? options.lock?.repos[name]?.url;
      if (url === undefined) continue;

      try {
        const lookup = await this.indexCache.getIndex(name, {
          url,
          ...(repos[name]?.provider === undefined
            ? {}
            : { provider: repos[name]!.provider! }),
          maxAgeSeconds: freshnessSeconds,
          ...(options.force === undefined ? {} : { force: options.force }),
        });
        indexes.set(name, lookup.index);
      } catch (error) {
        this.warn(
          `Sous could not read the index of the repository '${name}', so nothing in it ` +
            `can be resolved right now.\n${describeError(error)}`
        );
      }
    }

    return indexes;
  }

  // --- The store ---------------------------------------------------------------------------------

  /**
   * The directory a resolved recipe's files are read from: a linked working copy
   * when the repository is linked, otherwise its store entry.
   *
   * @param recipe - The resolved recipe.
   */
  private recipeDirectory(recipe: ResolvedRecipe): string {
    const checkout = linkedPathFor(recipe.repo, this.sousDir, this.env);
    if (checkout !== undefined) {
      const linked = mapLinkedRecipes(checkout)[recipe.key];
      if (linked !== undefined) return linked;
    }
    return this.storeInstance.entryDir(storeKeyFor(recipe));
  }

  /**
   * Makes sure a resolved recipe's files are in the store, fetching them when
   * they are not. A linked repository is read from its checkout and is never
   * fetched.
   *
   * @param recipe - The resolved recipe.
   */
  private async ensureStored(recipe: ResolvedRecipe): Promise<void> {
    if (linkedPathFor(recipe.repo, this.sousDir, this.env) !== undefined) return;

    const key = storeKeyFor(recipe);
    const hit = await this.storeInstance.get(key);
    if (hit !== undefined && hit.entry.hash === recipe.hash) return;

    const repos = this.currentRepos();
    const url = repos[recipe.repo]?.url;
    if (url === undefined) {
      throw new ConfigError(
        `Sous cannot fetch '${recipe.key}' because it no longer knows where the ` +
          `repository '${recipe.repo}' lives.\n` +
          `  Add it with 'sous repo add <url> --name ${recipe.repo}'.`
      );
    }

    await this.fetchIntoStore({
      repo: recipe.repo,
      key: recipe.key,
      version: recipe.version,
      hash: recipe.hash,
      tag: recipe.tag,
      recipePath: recipe.path,
      url,
      providerId: repos[recipe.repo]?.provider,
    });
  }

  /**
   * Fetches one recipe version into the store, verifying it against the hash the
   * index publishes. The download lands in a temporary directory beside the
   * store, so a failed fetch never leaves a half-written entry behind.
   *
   * @param request - Which version to fetch, from where, and at which tag.
   */
  private async fetchIntoStore(request: {
    repo: string;
    key: string;
    version: string;
    hash: string;
    tag: string;
    recipePath: string;
    url: string;
    providerId?: string;
  }): Promise<void> {
    const provider = requireProvider(request.url, request.providerId, this.providers);
    const canonical = provider.canonicalize(request.url);

    const namespace = request.key.slice(0, request.key.indexOf("/"));
    const key: StoreKey = {
      repo: request.repo,
      namespace,
      name: request.key.slice(namespace.length + 1),
      version: request.version,
    };

    await fsp.mkdir(this.storeInstance.root, { recursive: true });
    const workDir = await fsp.mkdtemp(path.join(this.storeInstance.root, ".sous-fetch-"));
    const fetchDir = path.join(workDir, key.name);
    try {
      await provider.fetchRecipeTree(
        canonical,
        request.recipePath,
        request.tag,
        fetchDir,
        this.providerOptions
      );
      await this.storeInstance.put(key, fetchDir, request.hash);
    } finally {
      await fsp.rm(workDir, { recursive: true, force: true });
    }
  }

  /**
   * The manifest loader the resolver walks the dependency closure with. It
   * fetches the recipe when the store does not hold it, which is the seam where
   * "resolve" turns into "download"; a dry run refuses to fetch and reads only
   * what is already there.
   *
   * @param recipe - The resolved recipe whose manifest is wanted.
   * @param dryRun - When true, read what is on disk and download nothing.
   */
  private async loadRecipeManifest(
    recipe: ResolvedRecipe,
    dryRun: boolean
  ): Promise<RecipeManifest | undefined> {
    const directory = this.recipeDirectory(recipe);
    const existing = readRecipeManifestIn(directory);
    if (existing !== undefined) return existing;
    if (dryRun) return undefined;

    await this.ensureStored(recipe);
    return readRecipeManifestIn(this.recipeDirectory(recipe));
  }

  // --- The managed subscriptions layer -----------------------------------------------------------

  /** Every subscription written in the managed layer, keyed by ref key. */
  private readSubscriptionEntries(): Record<string, SubscriptionEntry> {
    const layer = readManagedLayer(this.sousDir, SUBSCRIPTIONS_LAYER_FILENAME, {
      confDir: this.confDir,
    });
    const entries = layer["subscriptions"];
    if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return {};
    return entries as Record<string, SubscriptionEntry>;
  }

  /**
   * Records one subscription in the managed layer, replacing the file in full.
   *
   * @param key - The ref key the subscription is recorded under.
   * @param parsed - The ref as parsed, for its version range.
   * @param options - The prerelease and always-pull flags.
   */
  private writeSubscriptionEntry(
    key: string,
    parsed: ParsedRef,
    options: SubscribeOptions
  ): void {
    const entry: SubscriptionEntry = {
      ...(parsed.range === undefined ? {} : { range: parsed.range }),
      ...(options.prerelease === true ? { prerelease: true } : {}),
      ...(options.alwaysPull === true ? { alwaysPull: true } : {}),
      addedAt: this.now().toISOString(),
      addedBy: USER_ADDED_BY,
    };

    writeManagedLayer(
      this.sousDir,
      SUBSCRIPTIONS_LAYER_FILENAME,
      { subscriptions: { ...this.readSubscriptionEntries(), [key]: entry } },
      { confDir: this.confDir }
    );
  }

  // --- Lockfile bookkeeping ----------------------------------------------------------------------

  /**
   * The lockfile keys one subscription holds directly. A recipe ref holds its
   * own key; a namespace ref holds every recipe in that namespace.
   *
   * @param lock - The lockfile as it stands.
   * @param key - The subscription's ref key.
   */
  private keysHeldBySubscription(lock: Lockfile, key: string): string[] {
    if (key.includes("/")) {
      return Object.hasOwn(lock.recipes, key) ? [key] : [];
    }
    return Object.keys(lock.recipes)
      .filter((entry) => entry.startsWith(`${key}/`))
      .sort();
  }

  /**
   * Drops the project's own hold on one recipe. When something else still holds
   * it the entry stays; when nothing does, the entry goes and everything it
   * pulled in is reconsidered, which is what makes removal refcounted.
   *
   * @param lock - The lockfile as it stands.
   * @param key - The recipe key to release.
   */
  private dropProjectHold(lock: Lockfile, key: string): Lockfile {
    const entry = lock.recipes[key];
    if (entry === undefined) return lock;

    const kept = entry.requestedBy.filter((holder) => holder !== PROJECT_HOLDER);
    const recipes = { ...lock.recipes };

    if (kept.length > 0) {
      recipes[key] = { ...entry, requestedBy: kept };
      return { ...lock, recipes };
    }

    delete recipes[key];
    return this.lock.removeHolder({ ...lock, recipes }, key);
  }

  /**
   * True when a repository prefers a newer in-range version over the locked one,
   * whether the flag is on the repository itself or on any subscription that
   * resolves inside it.
   *
   * @param repoName - The repository's short name.
   * @param repo - Its config entry, when it still has one.
   * @param lock - The lockfile, for which recipes came from it.
   * @param subscriptions - Every subscription, from the config and the managed layer.
   */
  private prefersNewer(
    repoName: string,
    repo: TrustedRepo | undefined,
    lock: Lockfile,
    subscriptions: Record<string, SubscriptionEntry>
  ): boolean {
    if (repo?.alwaysPull === true) return true;

    for (const [key, entry] of Object.entries(subscriptions)) {
      if (entry.alwaysPull !== true) continue;
      const keys = this.keysHeldBySubscription(lock, key);
      if (keys.some((held) => lock.recipes[held]!.repo === repoName)) return true;
    }

    return false;
  }

  // --- Variables ----------------------------------------------------------------------------------

  /**
   * Asks for the variables the newly resolved recipes publish, keeping and
   * reporting whatever answers were already in scope. A run with no terminal
   * fails naming the exact environment variables that would answer each
   * question, which is what the variables layer does everywhere.
   *
   * @param resolved - The recipe versions the resolution settled on.
   */
  private async askVariables(resolved: ResolvedRecipe[]): Promise<AskReport | undefined> {
    const defined: DefinedVariable[] = [];

    for (const recipe of resolved) {
      const manifest = readRecipeManifestIn(this.recipeDirectory(recipe));
      if (manifest === undefined) continue;

      const publisher: DefiningRecipe = {
        repo: recipe.repo,
        namespace: recipe.namespace,
        name: recipe.name,
        version: recipe.version,
      };
      for (const definition of manifest.variables ?? []) {
        defined.push({ definition, recipe: publisher });
      }
    }

    if (defined.length === 0) return undefined;

    return askForMissing(
      defined,
      loadLadderContext({
        sousDir: this.sousDir,
        settings: this.settings,
        shellEnv: this.shellEnv,
      }),
      {
        sousDir: this.sousDir,
        confDir: this.confDir,
        interactive: this.interactive,
      }
    );
  }
}

// --- Helpers ------------------------------------------------------------------------------------

/** One subscription entry, as it is written into the managed layer. */
export type SubscriptionEntry = {
  /** The semantic version range to resolve within. */
  range?: string;
  /** Whether prerelease versions take part in range matching. */
  prerelease?: boolean;
  /** Whether a newer in-range version is preferred over the locked one. */
  alwaysPull?: boolean;
  /** When the subscription was added. */
  addedAt?: string;
  /** Who required it: "user", or the ref of the recipe that co-subscribed it. */
  addedBy?: string;
};

/** The store key a resolved recipe is filed under. */
function storeKeyFor(recipe: ResolvedRecipe): StoreKey {
  return {
    repo: recipe.repo,
    namespace: recipe.namespace,
    name: recipe.name,
    version: recipe.version,
  };
}

/** The message of an error, whichever kind it turned out to be. */
function describeError(error: unknown): string {
  if (isConfigError(error)) return (error as ConfigError).message;
  return error instanceof Error ? error.message : String(error);
}
