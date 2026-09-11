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
import semver from "semver";
import { ConfigError, isConfigError } from "../errors.js";
import { SOUS_VERSION, type ConfigContext, type Settings } from "../settings.js";
import { CONFD_DIR_NAME } from "../config-discovery.js";
import { indent, log, warning } from "../../utils/formatting.js";
import { askChoice, askYesNo } from "../../utils/prompts.js";
import { isInteractive, nonInteractiveError } from "../interactive.js";
import {
  applyProvidedAnswers,
  askForMissing,
  loadLadderContext,
  planQuestions,
  type AskReport,
  type DefinedVariable,
  type DefiningRecipe,
  type LadderContext,
  type PlannedVariable,
  type ProvidedAnswer,
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
  candidateToRef,
  describeCandidate,
  describeSearch,
  searchBareName,
  type RefCandidate,
} from "./ref-search.js";
import {
  PROJECT_REQUESTER,
  resolveRefs,
  type RefRequest,
  type ResolvedRecipe,
  type ResolverRepo,
} from "./resolver.js";
import { LockService, type LockDiff, type RestoreReport } from "./lock-service.js";
import { TrustService, USER_ADDED_BY, type TrustedRepo } from "./trust.js";
import {
  SUBSCRIPTIONS_LAYER_FILENAME,
  readManagedLayer,
  removeManagedLayer,
  updateManagedLayer,
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
import {
  assertLocalRepoDirectory,
  looksLikeLocalPath,
  resolveRepoArgument,
} from "./providers/local.js";
import { RecipeStore } from "./store/recipe-store.js";
import type { RecipeStoreLike, StoreKey } from "./store/contract.js";
import { resolveStoreSettings } from "./store/settings.js";
import {
  effectiveRangeForHolders,
  findNewerInRange,
  recordUpstreamCheck,
  shouldCheckUpstream,
} from "./freshness.js";
import { REPO_NAME_PATTERN } from "./formats/patterns.js";
import { linkedPathFor } from "./links.js";
import {
  keysHeldBySubscription,
  listLockedRecipes,
  mapLinkedRecipes,
  readRecipeManifestIn,
} from "./locked-recipes.js";
import { resolveStoreRoot } from "../sous-home.js";
import { seedCoreRecipe, type SeedCoreRecipeReport } from "./seed.js";
import { enabledRepos, enabledSubscriptions, isBuiltInEntry } from "./defaults.js";
import { CORE_RECIPE_KEY, OFFICIAL_REPO_NAME, packagedCoreRecipeDir } from "./core-recipe.js";
import { hashDirectory } from "./store/hash.js";

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
  /** Where the plan and the resolution notices go. Defaults to the console. */
  write?: (message: string) => void;
  /** How a yes or no question is asked. Injected in tests. */
  ask?: (message: string) => Promise<boolean>;
  /** How a choice between candidate refs is asked. Injected in tests. */
  choose?: (
    message: string,
    candidates: RefCandidate[]
  ) => Promise<RefCandidate>;
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
  /** Accept the subscribe confirmation without being asked. */
  yes?: boolean;
  /** Take the first candidate when a one-word ref matched several things. */
  acceptFirst?: boolean;
  /**
   * Answers supplied ahead of the questions, which are validated and stored
   * before anything is asked. See `lib/vars/preanswers.ts`.
   */
  answers?: ProvidedAnswer[];
  /** Work out what would happen and report it, writing and fetching nothing. */
  dryRun?: boolean;
};

/** What `subscribe` did. */
export type SubscribeOutcome = {
  /** The ref that was installed, fully qualified, in its canonical written form. */
  ref: string;
  /** The ref as it was written, when a one-word ref had to be resolved first. */
  resolvedFrom?: string;
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
  /**
   * Every question these recipes would ask, and where each answer would go.
   * Reported by a dry run, which is how a caller with no terminal finds out
   * what to supply with `--answer`.
   */
  questions?: PlannedVariable[];
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
  /**
   * True when the subscription was one sous provides itself, so it was switched
   * off with an `enabled: false` entry rather than deleted. The entry sous
   * provides comes back on every run; only a recorded opt-out outlives it.
   */
  optedOut: boolean;
  /** True when nothing was written, because this was a dry run. */
  dryRun: boolean;
};

/** One row of the subscription listing: what a project subscribes to, and why. */
export type SubscriptionListing = {
  /** The ref key: a bare namespace, or `namespace/recipe`. */
  key: string;
  /** The version range the subscription resolves within, when one was written. */
  range: string | undefined;
  /** False when the entry is switched off with `enabled: false`. */
  enabled: boolean;
  /** What the entry recorded about who wanted it, when it recorded anything. */
  addedBy: string | undefined;
  /** Every recipe the lockfile pins because of this subscription, sorted by key. */
  pinned: Array<{ key: string; version: string }>;
};

/** What bringing the lockfile in line with the declared subscriptions produced. */
export type SubscriptionSyncReport = {
  /** The subscriptions that had to be resolved, by ref key. */
  resolved: string[];
  /** Recipes the lockfile did not pin before and pins now. */
  added: Array<{ key: string; version: string }>;
  /** Recipes whose pinned version moved to satisfy a subscription's range. */
  moved: Array<{ key: string; from: string; to: string }>;
  /** Subscriptions that could not be resolved, each with a plain-language reason. */
  failed: Array<{ key: string; reason: string }>;
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

  private readonly write: (message: string) => void;

  private readonly ask: (message: string) => Promise<boolean>;

  private readonly choose: (
    message: string,
    candidates: RefCandidate[]
  ) => Promise<RefCandidate>;

  private readonly now: () => Date;

  private readonly storeInstance: RecipeStoreLike;

  private readonly indexCache: IndexCache;

  private readonly trust: TrustService;

  private readonly lock: LockService;

  /**
   * What seeding the packaged core recipe did, once it has been done. Seeding is
   * idempotent but not free (it verifies the store entry against its content
   * hash), so one service instance does it at most once.
   */
  private seedReport: SeedCoreRecipeReport | undefined;

  /**
   * Where each locked recipe's files are, keyed by recipe key, once it has been
   * looked up. Deriving the range a `depends`-held recipe may move within asks
   * for this once per lockfile entry, and the answer does not change during a
   * command.
   */
  private lockedDirectories: Record<string, string> | undefined;

  /**
   * Every trusted repository's index, once it has been loaded. Working out what
   * a one-word ref meant and describing what a subscription will do both read
   * it, within one command, and an index does not change mid-command.
   */
  private indexesSnapshot: Map<string, IndexFile> | undefined;

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
    this.write = options.write ?? ((message: string) => log(message));
    this.ask = options.ask ?? ((message: string) => askYesNo(message));
    this.choose =
      options.choose ??
      ((message, candidates) =>
        askChoice(
          message,
          candidates.map((candidate) => ({
            name: describeCandidate(candidate),
            value: candidate,
          }))
        ));
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

  /** The index cache, for a command that wants to read a cached index without fetching. */
  get indexes(): IndexCache {
    return this.indexCache;
  }

  // --- Adding a repository ----------------------------------------------------------------------

  /**
   * Adds a repository, which is the same thing as trusting it, and then fetches
   * exactly one file from it: its index. Nothing is downloaded before the trust
   * question is answered.
   *
   * A path is normalized before anything else happens: `~` is expanded and a
   * relative path is resolved against the working directory, so what gets
   * stored is always absolute (a repository on this machine is machine-specific
   * whichever way it was typed). A path that is not a repository is reported as
   * a path mistake, naming what was typed and where sous looked, rather than as
   * a provider that could not be found.
   *
   * @param options - The URL, an optional short name and provider, and the trust flag.
   */
  async addRepo(options: AddRepoOptions): Promise<AddRepoOutcome> {
    const typed = options.url.trim();
    const url = resolveRepoArgument(typed);
    if (looksLikeLocalPath(typed)) assertLocalRepoDirectory(typed, url);
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
    const written = parseRef(options.ref);
    const dryRun = options.dryRun === true;

    // A one-word ref is a guess at a name, and the guess is settled here, from
    // the cached indexes alone. Everything after this point works with a fully
    // qualified ref, so what is confirmed is exactly what is installed.
    const parsed = await this.resolveBareRef(written, options);
    const key = refKey(parsed);

    // The last gate before anything is fetched or written: what this will do to
    // the project, in plain sentences, and a question.
    await this.confirmSubscription(parsed, options);

    const { resolved, trusted, cycles } = await this.resolveClosure(parsed, options);

    const before = this.lock.read();
    const after = this.lock.applyResolution(before, resolved, this.lockRepoInputs());
    const diff = this.lock.diff(before, after);

    const resolvedFrom =
      formatRef(written) === formatRef(parsed) ? {} : { resolvedFrom: formatRef(written) };

    if (dryRun) {
      // The questions are planned even here, so `--dry-run` is the command an
      // agent runs to find out what a subscription will want to know. Answers
      // supplied with it are validated and reported, and nothing is written.
      const defined = this.definedVariables(resolved);
      const context = this.ladderContext();
      const supplied = applyProvidedAnswers(defined, options.answers ?? [], context, {
        sousDir: this.sousDir,
        confDir: this.confDir,
        interactive: this.interactive,
        dryRun: true,
      });

      return {
        ref: formatRef(parsed),
        ...resolvedFrom,
        key,
        resolved,
        trusted,
        diff,
        cycles,
        questions: planQuestions(defined, context, { sousDir: this.sousDir }),
        ...(supplied.stored.length === 0
          ? {}
          : { answers: { answered: supplied.stored, inherited: [], skipped: [] } }),
        dryRun: true,
      };
    }

    for (const recipe of resolved) await this.ensureStored(recipe);

    this.lock.write(after);
    this.writeSubscriptionEntry(key, parsed, options);

    const answers = await this.askVariables(resolved, options.answers ?? []);

    return {
      ref: formatRef(parsed),
      ...resolvedFrom,
      key,
      resolved,
      trusted,
      diff,
      answers,
      cycles,
      dryRun: false,
    };
  }

  // --- Working out what a one-word ref meant -----------------------------------------------------

  /**
   * Settles what a ref names, reading nothing but the cached indexes.
   *
   * A ref with two segments already says what it names and is handed back
   * untouched. A ref with one segment is searched for as a namespace first and
   * as a recipe name second (`ref-search.ts` holds the rule and the order):
   * nothing found is an error naming what was searched, one candidate is used
   * and reported, and several are chosen between. `--accept-first` takes the
   * first candidate in the documented order; a run that cannot ask fails and
   * says so.
   *
   * @param written - The ref exactly as the user wrote it.
   * @param options - The accept-first flag.
   */
  private async resolveBareRef(
    written: ParsedRef,
    options: SubscribeOptions
  ): Promise<ParsedRef> {
    if (written.recipe !== undefined) return written;

    const repoOrder = this.repoSearchOrder(written.repo);
    const indexes = await this.loadIndexes(repoOrder);
    if (written.repo === undefined) this.indexesSnapshot = indexes;
    const inputs = { name: written.namespace, repoOrder, indexes };
    const candidates = searchBareName(inputs);

    if (candidates.length === 0) {
      throw new ConfigError(
        [
          `Nothing called '${written.namespace}' was found: no namespace has that name, ` +
            `and no recipe does either.`,
          ...describeSearch(inputs),
          `  Run 'sous repo search ${written.namespace}' to look for something like it, or ` +
            `'sous repo add <url>' to add the repository that publishes it.`,
        ].join("\n")
      );
    }

    if (candidates.length === 1) {
      return this.acceptCandidate(candidates[0]!, written);
    }

    if (options.acceptFirst === true) {
      this.write(
        indent(
          `'${written.namespace}' matched ${candidates.length} things; taking the first, ` +
            `because '--accept-first' was passed.`
        )
      );
      return this.acceptCandidate(candidates[0]!, written);
    }

    if (!this.interactive) {
      throw nonInteractiveError({
        prompt: `which '${written.namespace}' you meant`,
        remedy:
          `write the full ref (for example 'sous subscribe ${candidates[0]!.ref}'), or pass ` +
          `'--accept-first' to take the first candidate listed above.`,
        details: [
          `'${written.namespace}' matched ${candidates.length} things:`,
          ...candidates.map((candidate) => `  ${describeCandidate(candidate)}`),
        ],
      });
    }

    const chosen = await this.choose(
      `Which '${written.namespace}' did you mean?`,
      candidates
    );
    return candidateToRef(chosen, written);
  }

  /**
   * Reports what a one-word ref resolved to, and hands back the qualified ref.
   *
   * @param candidate - The candidate that won.
   * @param written - The ref exactly as the user wrote it.
   */
  private acceptCandidate(candidate: RefCandidate, written: ParsedRef): ParsedRef {
    this.write(indent(`'${written.namespace}' resolves to ${describeCandidate(candidate)}.`));
    return candidateToRef(candidate, written);
  }

  /**
   * The repositories a one-word ref is searched in, in the order their
   * candidates are listed: the built-in repository first, then the ones the
   * config names, in the order the config names them.
   *
   * @param only - A repository qualifier from the ref, which narrows the search to it.
   */
  private repoSearchOrder(only?: string): string[] {
    const repos = this.currentRepos();
    const names = Object.keys(repos);

    if (only !== undefined) {
      if (!Object.hasOwn(repos, only)) {
        throw new ConfigError(
          `This project does not trust a repository called '${only}'.\n` +
            (names.length > 0
              ? `  It trusts: ${names.join(", ")}.`
              : `  It trusts none yet.`) +
            `\n  Add it with 'sous repo add <url> --name ${only}'.`
        );
      }
      return [only];
    }

    const builtIn = names.filter((name) => isBuiltInEntry(repos[name]));
    return [...builtIn, ...names.filter((name) => !builtIn.includes(name))];
  }

  /**
   * Every trusted repository's index, loaded once per command. Whatever a
   * one-word ref already loaded is reused, so confirming a subscription costs
   * no extra lookups.
   */
  private async indexSnapshot(): Promise<Map<string, IndexFile>> {
    if (this.indexesSnapshot === undefined) {
      this.indexesSnapshot = await this.loadIndexes(this.repoSearchOrder());
    }
    return this.indexesSnapshot;
  }

  // --- The subscribe confirmation ----------------------------------------------------------------

  /**
   * Says what subscribing will do to this project, and asks whether to go on.
   *
   * This runs before anything is fetched or written, so a "no" costs nothing:
   * the only thing read to get here is the cached index of each trusted
   * repository. `--yes` skips the question, and a dry run states the plan and
   * never asks, because a dry run has nothing to decline.
   *
   * @param parsed - The fully qualified ref being subscribed to.
   * @param options - The yes and dry-run flags.
   */
  private async confirmSubscription(
    parsed: ParsedRef,
    options: SubscribeOptions
  ): Promise<void> {
    const indexes = await this.indexSnapshot();
    const plan = await this.subscriptionPlan(parsed, options, indexes);
    for (const line of plan) this.write(line === "" ? "" : indent(line));

    if (options.dryRun === true || options.yes === true) return;

    if (!this.interactive) {
      throw nonInteractiveError({
        prompt: `whether to go ahead with subscribing to '${formatRef(parsed)}'`,
        remedy:
          "pass '--yes' (spelled '-y', '--force' or '--trust' if you prefer) to accept " +
          "the plan above without being asked.",
      });
    }

    const proceed = await this.ask("Proceed?");
    if (!proceed) {
      throw new ConfigError(
        `Nothing was written: the subscription to '${formatRef(parsed)}' was declined.\n` +
          `  Nothing was downloaded, no lockfile entry was made, and this project's ` +
          `config is exactly as it was.`
      );
    }
  }

  /**
   * The plan itself: what will be compiled, what can run, what will be asked,
   * and what will be fetched, in plain sentences.
   *
   * @param parsed - The fully qualified ref being subscribed to.
   * @param options - The prerelease flag, for the dependency peek.
   */
  private async subscriptionPlan(
    parsed: ParsedRef,
    options: SubscribeOptions,
    indexes: Map<string, IndexFile>
  ): Promise<string[]> {
    const target = formatRef(parsed);
    const lines: string[] = [""];

    if (parsed.recipe === undefined) {
      const published = this.namespaceRecipes(parsed, indexes);
      lines.push(
        `Subscribing to '${target}' subscribes this project to the whole namespace ` +
          `'${parsed.namespace}', which means every recipe in it, including ones ` +
          `published later.`
      );
      if (published.length > 0) {
        lines.push(`It publishes ${published.length} today: ${published.join(", ")}.`);
      }
    } else {
      lines.push(
        `Subscribing to '${target}' installs the recipe '${parsed.recipe}' from the ` +
          `namespace '${parsed.namespace}'.`
      );
    }

    lines.push("");
    lines.push("Here is what that does:");
    lines.push("");
    lines.push(
      `  The files it ships are compiled into this project on the next build, which ` +
        `writes them into this project's agent directories.`
    );
    lines.push(
      `  Any scripts it ships can be run on this machine when an agent uses them. ` +
        `Sous does not run them itself, and it cannot vouch for what they do.`
    );
    lines.push(
      `  The variables it publishes are asked about at the end of this command, and ` +
        `the answers are written into this project's env files.`
    );
    lines.push(
      `  Its dependencies are fetched and pinned in this project's lockfile, at the ` +
        `exact versions resolved now.`
    );

    const untrusted = await this.knownUntrustedDependencyRepos(parsed, options, indexes);
    if (untrusted.length > 0) {
      lines.push(
        `  Some of what it needs lives in repositories this project does not trust ` +
          `yet: ${untrusted.join(", ")}. You are asked about each one by name before ` +
          `anything is fetched from it.`
      );
    } else {
      lines.push(
        `  If a dependency turns out to live in a repository this project does not ` +
          `trust, sous stops and asks about that repository by name before fetching ` +
          `anything from it.`
      );
    }

    lines.push("");
    return lines;
  }

  /**
   * The recipes a namespace publishes today, as `namespace/recipe` keys.
   *
   * @param parsed - The fully qualified namespace ref.
   */
  private namespaceRecipes(parsed: ParsedRef, indexes: Map<string, IndexFile>): string[] {
    const index = parsed.repo === undefined ? undefined : indexes.get(parsed.repo);
    if (index === undefined) return [];
    return Object.keys(index.recipes)
      .filter((key) => key.startsWith(`${parsed.namespace}/`))
      .sort();
  }

  /**
   * Repositories a dependency needs that this project does not trust, as far as
   * anything already on disk knows.
   *
   * A manifest is the only thing that names a dependency, and a manifest that
   * has never been fetched cannot be read without fetching, which is exactly
   * what the confirmation exists to gate. So this reads what the store already
   * holds, and says nothing when it holds nothing; the trust ceremony during
   * resolution is still where the real answer comes from.
   *
   * @param parsed - The fully qualified ref being subscribed to.
   * @param options - The prerelease flag.
   */
  private async knownUntrustedDependencyRepos(
    parsed: ParsedRef,
    options: SubscribeOptions,
    indexes: Map<string, IndexFile>
  ): Promise<string[]> {
    try {
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
          repos: this.resolverRepos(),
          // Reads only what is already on disk: the confirmation must not fetch.
          loadManifest: (recipe) => this.loadRecipeManifest(recipe, true),
          ...(options.prerelease === true ? { prerelease: true } : {}),
        }
      );
      return result.missingRepos.map((missing) => `'${missing.name}'`).sort();
    } catch {
      // The plan is a courtesy; a peek that fails must never stop a subscription
      // that resolution itself would have completed.
      return [];
    }
  }

  /**
   * Resolves a ref and everything beneath it, running the trust round as often
   * as resolution keeps turning up repositories the project has not added.
   *
   * IN PRACTICE THIS RUNS AT MOST ONE TRUST ROUND TODAY, and the loop is the
   * shape rather than the behavior. A recipe names the repository it depends on
   * by short name only, so nothing in a manifest carries a URL and every missing
   * repository comes back under `needUrl`, which throws below. The loop earns
   * its keep the moment any source of URLs exists (a repository hint block, or
   * the lockfile of a project restoring someone else's commit); until then, read
   * it as "one round, then either resolution succeeds or the person is told what
   * to add".
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
    const configured = enabledSubscriptions(this.settings);
    const before = this.lock.read();
    const held = this.keysHeldBySubscription(before, key);

    // An entry the managed layer already switched off is not a subscription any
    // more, so removing it again is the "you do not subscribe to this" case
    // rather than a deletion that would quietly switch it back on.
    const alreadyOff = managed[key]?.enabled === false;
    const removable = Object.hasOwn(managed, key) && !alreadyOff;
    // Sous provides the `core` subscription itself, so there is no entry to
    // delete. Removing it means recording an opt-out that outlives the default.
    const builtIn = !removable && isBuiltInEntry(configured[key]);

    if (!removable && !builtIn && !Object.hasOwn(configured, key) && held.length === 0) {
      const known = [
        ...new Set([
          ...Object.entries(managed)
            .filter(([, entry]) => entry?.enabled !== false)
            .map(([entryKey]) => entryKey),
          ...Object.keys(configured),
        ]),
      ].sort();
      throw new ConfigError(
        `This project does not subscribe to '${key}'.\n` +
          (known.length > 0
            ? `  It subscribes to: ${known.join(", ")}.`
            : `  It has no subscriptions yet.`)
      );
    }

    if (!removable && !builtIn && Object.hasOwn(configured, key)) {
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
      if (builtIn) remaining[key] = { enabled: false };
      else delete remaining[key];

      if (Object.keys(remaining).length === 0) {
        removeManagedLayer(this.sousDir, SUBSCRIPTIONS_LAYER_FILENAME, {
          confDir: this.confDir,
        });
      } else {
        // A subscription sous provides itself has no entry to delete, so the
        // opt-out is written as the entry instead; anything else is removed.
        updateManagedLayer(
          this.sousDir,
          SUBSCRIPTIONS_LAYER_FILENAME,
          [
            {
              path: ["subscriptions", key],
              value: builtIn ? { enabled: false } : undefined,
            },
          ],
          { confDir: this.confDir }
        );
      }
    }

    return { key, diff, stayed, optedOut: builtIn, dryRun };
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
   * Puts the core recipe that ships inside the sous package into the store, and
   * writes a stand-in index for the official repository when nothing real has
   * ever been fetched. This runs before anything else a build does, because it
   * is what lets a project with no network resolve the `core` namespace at all.
   *
   * Idempotent, offline, and never fatal: a failure comes back in the report as
   * a sentence to warn about.
   */
  async seedCore(): Promise<SeedCoreRecipeReport> {
    if (this.seedReport !== undefined) return this.seedReport;
    this.seedReport = await seedCoreRecipe({
      store: this.storeInstance,
      sousVersion: SOUS_VERSION,
      now: this.now,
    });
    return this.seedReport;
  }

  /**
   * Brings the lockfile in line with the subscriptions the config declares.
   *
   * A subscription is normally written by `sous subscribe`, which locks it on
   * the spot. Two cases leave one declared but unlocked, and both have to work
   * without anyone typing a command: a subscription hand-written into the config
   * (or arriving with a colleague's commit), and the built-in `core`
   * subscription, whose range is the running sous version and therefore changes
   * every time sous is upgraded.
   *
   * So a subscription is resolved here when the lockfile pins nothing for it, or
   * pins something its range no longer allows. Everything else is left exactly
   * as the lockfile has it; a build never re-decides a version it already has.
   *
   * Nothing here is fatal and nothing here prompts. A build must not stop
   * because a repository is unreachable, and it must never block on a question,
   * so a subscription that cannot be resolved comes back in the report as a
   * sentence to warn about.
   */
  async ensureSubscriptionsLocked(): Promise<SubscriptionSyncReport> {
    const report: SubscriptionSyncReport = {
      resolved: [],
      added: [],
      moved: [],
      failed: [],
    };

    const subscriptions = this.allSubscriptions();
    const before = this.lock.read();

    const pending: Array<{ key: string; request: RefRequest }> = [];
    for (const key of Object.keys(subscriptions).sort()) {
      const entry = subscriptions[key]!;
      if (this.subscriptionIsLocked(key, entry, before)) continue;

      let parsed: ParsedRef;
      try {
        parsed = parseRef(key);
      } catch (error) {
        report.failed.push({ key, reason: describeError(error) });
        continue;
      }

      pending.push({
        key,
        request: {
          ref: {
            ...parsed,
            ...(entry.range === undefined ? {} : { range: entry.range }),
          },
          requestedBy: PROJECT_REQUESTER,
          kind: "subscribes",
          ...(entry.prerelease === true ? { prerelease: true } : {}),
        },
      });
    }

    if (pending.length === 0) return report;

    const repos = this.resolverRepos();
    const indexes = await this.loadIndexes(Object.keys(repos), { lock: before });

    // Each subscription is resolved on its own. Resolving them together would be
    // one call, but the resolver raises on the first ref it cannot settle, and a
    // project should not lose four subscriptions because one of them names a
    // recipe that no longer exists. What the separate resolutions produce is
    // merged back together below, so a recipe two subscriptions both depend on
    // still records both of them as holders.
    const stored = new Map<string, ResolvedRecipe>();
    for (const { key, request } of pending) {
      let result;
      try {
        result = await resolveRefs([request], {
          indexes,
          repos,
          loadManifest: (recipe) => this.loadRecipeManifest(recipe, false),
        });
      } catch (error) {
        report.failed.push({ key, reason: describeError(error) });
        continue;
      }

      // A repository something needs but the project has not added is a trust
      // decision, and a build is the wrong moment to ask for one. Say which
      // command grants it, and leave this subscription alone.
      if (result.missingRepos.length > 0) {
        const names = result.missingRepos.map((missing) => missing.name);
        report.failed.push({
          key,
          reason:
            `Sous has not been told where ${
              names.length === 1
                ? `the repository '${names[0]}' lives`
                : `these repositories live: ${names.map((n) => `'${n}'`).join(", ")}`
            }, so it could not be resolved.\n` +
            names.map((name) => `  sous repo add <url> --name ${name}`).join("\n"),
        });
        continue;
      }

      let failed = false;
      const settled: ResolvedRecipe[] = [];
      for (const recipe of result.resolved) {
        try {
          await this.ensureStored(recipe);
          settled.push(recipe);
        } catch (error) {
          report.failed.push({ key, reason: describeError(error) });
          failed = true;
          break;
        }
      }

      if (failed) continue;
      report.resolved.push(key);

      for (const recipe of settled) {
        const already = stored.get(recipe.key);
        if (already === undefined) {
          stored.set(recipe.key, recipe);
          continue;
        }

        if (already.version !== recipe.version) {
          report.failed.push({
            key: recipe.key,
            reason:
              `Two of this project's subscriptions want different versions of ` +
              `'${recipe.key}': ${already.version} and ${recipe.version}. Sous kept ` +
              `${already.version}.\n` +
              `  Subscribe to '${recipe.key}' directly, with the range you want, so ` +
              `there is one answer.`,
          });
          continue;
        }

        stored.set(recipe.key, mergeHolders(already, recipe));
      }
    }

    if (stored.size === 0) return report;

    const settledRecipes = [...stored.values()];
    const after = this.lock.applyResolution(before, settledRecipes, this.lockRepoInputs());
    for (const recipe of settledRecipes) {
      const previous = before.recipes[recipe.key];
      if (previous === undefined) {
        report.added.push({ key: recipe.key, version: recipe.version });
      } else if (previous.version !== recipe.version) {
        report.moved.push({
          key: recipe.key,
          from: previous.version,
          to: recipe.version,
        });
      }
    }

    this.lock.write(after);
    return report;
  }

  /**
   * True when the lockfile already pins everything one subscription asks for, at
   * a version its range still allows.
   *
   * @param key - The subscription's ref key: a namespace, or `namespace/recipe`.
   * @param entry - The subscription entry, which carries the range.
   * @param lock - The lockfile as it stands.
   */
  private subscriptionIsLocked(
    key: string,
    entry: SubscriptionEntry,
    lock: Lockfile
  ): boolean {
    const matches = key.includes("/")
      ? lock.recipes[key] === undefined
        ? []
        : [lock.recipes[key]!]
      : Object.entries(lock.recipes)
          .filter(([lockedKey]) => lockedKey.startsWith(`${key}/`))
          .map(([, locked]) => locked);

    if (matches.length === 0) return false;

    const range = entry.range;
    const includePrerelease = entry.prerelease === true;

    return matches.every((locked) => {
      if (!locked.requestedBy.includes(PROJECT_HOLDER)) return false;
      if (range === undefined || range === "*") return true;
      return semver.satisfies(locked.version, range, { includePrerelease });
    });
  }

  /**
   * Makes the store hold exactly what the lockfile pins. Nothing here decides a
   * version and nothing here asks a question; that is what makes a fresh clone
   * reproducible.
   */
  async restore(): Promise<RestoreReport> {
    await this.seedCore();
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

        // Always-pull re-resolves WITHIN what was declared; it never widens it.
        // A recipe held only through another recipe's `depends` has no
        // subscription to read a range from, and treating that as "any version"
        // would move it straight past the constraint the dependency declared.
        const range = this.effectiveRangeFor(key, entry, subscriptions);
        if (range === undefined) continue;

        const newer = findNewerInRange({
          index,
          key,
          lockedVersion: entry.version,
          ...(range === "*" ? {} : { range }),
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
   * Everything a build needs done before it compiles: seed the packaged core
   * recipe, restore whatever else the store is missing, then look upstream for
   * the repositories that want a newer version. All three are quiet when there
   * is nothing to do.
   *
   * @param options - Whether to force the upstream check, and which freshness window to use.
   */
  async prepareForBuild(
    options: { force?: boolean; freshnessSeconds?: number } = {}
  ): Promise<{
    seed: SeedCoreRecipeReport;
    subscriptions: SubscriptionSyncReport;
    restored: RestoreReport | undefined;
    upstream: UpstreamCheckReport;
  }> {
    const seed = await this.seedCore();
    const subscriptions = await this.ensureSubscriptionsLocked();
    let restored: RestoreReport | undefined;
    if (this.needsRestore()) restored = await this.restore();
    const upstream = await this.checkUpstream(options);
    return { seed, subscriptions, restored, upstream };
  }

  // --- Reading the project's state ---------------------------------------------------------------

  /**
   * Every repository this project trusts, merging the config it was loaded with
   * and the managed layer as it stands on disk right now. The layer is re-read
   * because a trust round in this same process may have just written to it.
   */
  currentRepos(): Record<string, TrustedRepo> {
    return {
      ...(enabledRepos(this.settings) as Record<string, TrustedRepo>),
      ...this.trust.listManaged(),
    };
  }

  /**
   * Every subscription in force, from the config and from the managed layer.
   *
   * The managed layer is re-read rather than taken from the loaded config,
   * because a command in this same process may have just written to it; an entry
   * it switches off is dropped here, so removing a subscription sous provides
   * itself really does stop it being locked and built.
   */
  allSubscriptions(): Record<string, SubscriptionEntry> {
    const merged: Record<string, SubscriptionEntry> = {
      ...(enabledSubscriptions(this.settings) as Record<string, SubscriptionEntry>),
      ...this.readSubscriptionEntries(),
    };

    for (const [key, entry] of Object.entries(merged)) {
      if (entry?.enabled === false) delete merged[key];
    }
    return merged;
  }

  /**
   * Every subscription this project declares, switched-off ones included, with
   * the versions the lockfile pins because of each. Switched-off entries are
   * kept because an opt-out is part of what a project subscribes to, and hiding
   * it would make `sous subscription list` disagree with the config.
   *
   * Reads only what is already on disk, so the listing is safe offline.
   */
  listSubscriptions(): SubscriptionListing[] {
    const entries: Record<string, SubscriptionEntry> = {
      ...((this.settings.subscriptions ?? {}) as Record<string, SubscriptionEntry>),
      ...this.readSubscriptionEntries(),
    };

    const lock = this.lock.read();

    return Object.keys(entries)
      .sort()
      .map((key) => {
        const entry = entries[key]!;
        return {
          key,
          range: entry.range,
          enabled: entry.enabled !== false,
          addedBy: entry.addedBy,
          pinned: keysHeldBySubscription(lock, key).map((heldKey) => ({
            key: heldKey,
            version: lock.recipes[heldKey]!.version,
          })),
        };
      });
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

    // The store refuses to overwrite an entry whose content differs, because a
    // published version is immutable and one that changed underneath a project
    // is worth refusing loudly. There is exactly one entry that is not a
    // published version: the packaged core recipe sous seeds so a project can
    // build before it has ever reached the network. That copy is a stand-in for
    // the published one, not a rival to it, so when the two disagree at the same
    // version it steps aside and the published copy is fetched over it.
    if (hit !== undefined && (await this.isSeededCoreEntry(key, hit.entry.hash))) {
      await this.storeInstance.remove(key);
    }

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
   * True when a store entry is the packaged core recipe that seeding put there,
   * rather than anything fetched from a repository.
   *
   * The test is deliberately exact: the entry has to be the core recipe in the
   * official repository, AND its content has to hash to what this installation's
   * package holds. An entry that was genuinely fetched, or a seeded entry from a
   * different installation, is left alone.
   *
   * @param key - The store key being written to.
   * @param storedHash - The hash the entry currently holds.
   */
  private async isSeededCoreEntry(key: StoreKey, storedHash: string): Promise<boolean> {
    if (key.repo !== OFFICIAL_REPO_NAME) return false;
    if (`${key.namespace}/${key.name}` !== CORE_RECIPE_KEY) return false;

    try {
      return (await hashDirectory(packagedCoreRecipeDir())) === storedHash;
    } catch {
      // No packaged recipe to compare against means nothing here was seeded.
      return false;
    }
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
   * Records one subscription in the managed layer, editing only that entry.
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

    updateManagedLayer(
      this.sousDir,
      SUBSCRIPTIONS_LAYER_FILENAME,
      [{ path: ["subscriptions", key], value: entry }],
      { confDir: this.confDir }
    );
  }

  // --- Lockfile bookkeeping ----------------------------------------------------------------------

  /**
   * The lockfile keys one subscription holds directly. The rule itself lives in
   * `keysHeldBySubscription` (`locked-recipes.ts`), beside the other readers of
   * the lockfile's holder lists.
   *
   * @param lock - The lockfile as it stands.
   * @param key - The subscription's ref key.
   */
  private keysHeldBySubscription(lock: Lockfile, key: string): string[] {
    return keysHeldBySubscription(lock, key);
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

  /**
   * The version range an always-pull check may move one locked recipe within,
   * or undefined when sous cannot tell and therefore must not move it.
   *
   * The rule itself lives in `effectiveRangeForHolders`; this supplies it with
   * the two lookups it needs, one reading the project's subscriptions and one
   * reading the manifest of each holding recipe.
   *
   * @param key - The locked recipe key, `namespace/recipe`.
   * @param entry - Its lockfile entry, for its holders.
   * @param subscriptions - Every subscription, from the config and the managed layer.
   */
  private effectiveRangeFor(
    key: string,
    entry: LockedRecipe,
    subscriptions: Record<string, SubscriptionEntry>
  ): string | undefined {
    const namespace = key.split("/")[0]!;
    return effectiveRangeForHolders(key, entry.requestedBy, {
      subscriptionRange: (held) => {
        // A subscription the config no longer declares is not a hold sous can
        // read a range from; leave the entry alone rather than guessing.
        const subscription = subscriptions[held] ?? subscriptions[namespace];
        return subscription === undefined ? undefined : (subscription.range ?? "*");
      },
      dependencyRange: (holder, held) =>
        this.declaredDependencyRange(holder, held, namespace),
    });
  }

  /**
   * The range one recipe's manifest declares for a dependency, or undefined when
   * its manifest cannot be read or no longer names that dependency.
   *
   * @param holder - The holding recipe's key, `namespace/recipe`.
   * @param key - The held recipe's key.
   * @param namespace - The held recipe's namespace, since a `depends` entry may
   *   name a whole namespace rather than one recipe.
   */
  private declaredDependencyRange(
    holder: string,
    key: string,
    namespace: string
  ): string | undefined {
    const directory = this.lockedRecipeDirectories()[holder];
    if (directory === undefined) return undefined;

    let manifest;
    try {
      manifest = readRecipeManifestIn(directory);
    } catch {
      return undefined;
    }
    if (manifest === undefined) return undefined;

    for (const dependency of manifest.depends ?? []) {
      let parsed: ParsedRef;
      try {
        parsed = parseRef(dependency);
      } catch {
        continue;
      }
      const dependencyKey = refKey(parsed);
      if (dependencyKey !== key && dependencyKey !== namespace) continue;
      return parsed.range ?? "*";
    }

    return undefined;
  }

  /**
   * Where each locked recipe's files are, keyed by recipe key. Read once per
   * command, because an always-pull check asks for the same answer for every
   * entry in the lockfile.
   */
  private lockedRecipeDirectories(): Record<string, string> {
    if (this.lockedDirectories === undefined) {
      this.lockedDirectories = {};
      for (const located of listLockedRecipes({ sousDir: this.sousDir, env: this.env })) {
        if (located.present) this.lockedDirectories[located.key] = located.dir;
      }
    }
    return this.lockedDirectories;
  }

  // --- Variables ----------------------------------------------------------------------------------

  /**
   * Every variable definition the resolved closure publishes, attributed to the
   * recipe that declared it and to the chain that pulled it in.
   *
   * A recipe whose files are not on this machine contributes nothing rather
   * than failing, which is what lets a dry run describe as much of the closure
   * as it can without downloading any of it.
   *
   * @param resolved - The recipe versions the resolution settled on.
   */
  private definedVariables(resolved: ResolvedRecipe[]): DefinedVariable[] {
    const defined: DefinedVariable[] = [];
    const byKey = new Map(resolved.map((recipe) => [recipe.key, recipe]));
    const repos = this.currentRepos();

    /** One resolved recipe, described the way the variables layer shows it. */
    const describe = (recipe: ResolvedRecipe): DefiningRecipe => {
      const url = repos[recipe.repo]?.url;
      return {
        repo: recipe.repo,
        namespace: recipe.namespace,
        name: recipe.name,
        version: recipe.version,
        path: recipe.path,
        dir: this.recipeDirectory(recipe),
        ...(url === undefined ? {} : { url }),
      };
    };

    /** How a recipe came to be here: the subscribed recipe first, then each holder. */
    const chainFor = (recipe: ResolvedRecipe): ResolvedRecipe[] => {
      const chain = [recipe];
      const seen = new Set([recipe.key]);
      let current = recipe;

      while (!current.requestedBy.includes(PROJECT_HOLDER)) {
        const holderKey = current.requestedBy.find(
          (holder) => holder !== PROJECT_HOLDER && byKey.has(holder) && !seen.has(holder)
        );
        if (holderKey === undefined) break;
        current = byKey.get(holderKey)!;
        seen.add(holderKey);
        chain.unshift(current);
      }

      return chain;
    };

    // The subscribed recipe's own questions come first, then each dependency in
    // the order the closure reached it, so the run reads the way it happened.
    const ordered = [...resolved].sort((left, right) => {
      const depth = chainFor(left).length - chainFor(right).length;
      return depth !== 0 ? depth : left.key.localeCompare(right.key);
    });

    for (const recipe of ordered) {
      const manifest = readRecipeManifestIn(this.recipeDirectory(recipe));
      if (manifest === undefined) continue;

      const publisher = describe(recipe);
      const requiredBy = chainFor(recipe).map(describe);
      for (const definition of manifest.variables ?? []) {
        defined.push({ definition, recipe: publisher, requiredBy });
      }
    }

    return defined;
  }

  /** The environment layers and mapping records this project resolves against. */
  private ladderContext(): LadderContext {
    return loadLadderContext({
      sousDir: this.sousDir,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });
  }

  /**
   * Asks for the variables the newly resolved recipes publish, keeping and
   * reporting whatever answers were already in scope. Answers supplied ahead of
   * the questions are validated and stored first, so only what is left over is
   * asked for. A run with no terminal fails naming the exact environment
   * variables that would answer each remaining question, which is what the
   * variables layer does everywhere.
   *
   * @param resolved - The recipe versions the resolution settled on.
   * @param provided - Answers supplied ahead of the questions.
   */
  private async askVariables(
    resolved: ResolvedRecipe[],
    provided: ProvidedAnswer[]
  ): Promise<AskReport | undefined> {
    const defined = this.definedVariables(resolved);
    if (defined.length === 0 && provided.length === 0) return undefined;

    const context = this.ladderContext();
    const options = {
      sousDir: this.sousDir,
      confDir: this.confDir,
      interactive: this.interactive,
    };

    // A supplied answer naming a variable nothing declares fails here, before
    // any question is asked and before anything is stored.
    const supplied = applyProvidedAnswers(defined, provided, context, options);

    const report = await askForMissing(defined, context, {
      ...options,
      skip: supplied.keys,
    });
    report.answered.unshift(...supplied.stored);
    return report;
  }
}

// --- Helpers ------------------------------------------------------------------------------------

/**
 * Builds the subscription service for a running command, from what every
 * command already has: where its config was discovered, the merged settings,
 * and the shell environment as it was before the `.sous/` env files were loaded.
 *
 * @param options - The discovered config context, the settings, and the shell environment.
 */
export function subscriptionServiceFor(options: {
  /** Where the active config was found. */
  configContext: ConfigContext;
  /** The merged project config. */
  settings: Settings;
  /** The shell environment as it was before the env files were injected. */
  shellEnv?: NodeJS.ProcessEnv;
  /** Whether sous may ask questions. Defaults to whether both streams are a terminal. */
  interactive?: boolean;
}): SubscriptionService {
  return new SubscriptionService({
    sousDir: options.configContext.sousDir,
    ...(options.configContext.confDir === undefined
      ? {}
      : { confDir: options.configContext.confDir }),
    settings: options.settings,
    ...(options.shellEnv === undefined ? {} : { shellEnv: options.shellEnv }),
    ...(options.interactive === undefined ? {} : { interactive: options.interactive }),
  });
}

/** One subscription entry, as it is written into the managed layer. */
export type SubscriptionEntry = {
  /**
   * Whether the subscription takes part in anything. Defaults to true. Sous
   * writes `false` when a subscription it provides itself is removed, because
   * the default comes back on every run and only a recorded opt-out outlives it.
   */
  enabled?: boolean;
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

/**
 * Combines two resolutions of the SAME recipe version into one, so the lockfile
 * records every holder rather than only the last resolution's.
 *
 * This matters for removal: a recipe several subscriptions depend on has to
 * survive unsubscribing from one of them, and the lockfile's refcounting is what
 * decides that. A recipe anyone holds as a co-subscription is a co-subscription;
 * it is only a build dependency while nothing subscribes to it.
 *
 * @param left - The resolution already recorded.
 * @param right - The resolution to fold into it.
 */
function mergeHolders(left: ResolvedRecipe, right: ResolvedRecipe): ResolvedRecipe {
  const requestedBy = [...new Set([...left.requestedBy, ...right.requestedBy])].sort();

  const ranges = [...left.ranges];
  for (const entry of right.ranges) {
    const known = ranges.some(
      (seen) => seen.range === entry.range && seen.requestedBy === entry.requestedBy
    );
    if (!known) ranges.push(entry);
  }

  return {
    ...left,
    requestedBy,
    ranges,
    kind:
      left.kind === "subscribes" || right.kind === "subscribes" ? "subscribes" : "depends",
  };
}

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
