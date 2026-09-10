/**
 * The trust layer.
 *
 * Added equals trusted. There is no separate trust command and no trusted-but-
 * not-added state: a repository sous will read from is one written into the
 * project's `repos:` map, and removing the entry withdraws the trust. Until a
 * repository is added, sous downloads nothing from it, not even its index;
 * there is no peeking before trusting, because the decision rests on the URL
 * and the publisher's reputation, which are inspected outside sous.
 *
 * Resolution can turn up repositories a dependency needs but the project has
 * not added. Those come back from the resolver as `MissingRepo` entries with
 * their provenance, and this is where the user is asked about them: one
 * consolidated question per round, listing every new repository with its URL
 * and the recipe that requires it. A refusal aborts. A non-interactive run
 * fails hard, naming the repositories and the command that grants trust, and
 * `--trust` acknowledges without asking.
 */

import { color } from "@oclif/color";
import { ConfigError } from "../errors.js";
import type { Settings } from "../settings.js";
import { blankLine, log as writeLine } from "../../utils/formatting.js";
import { askYesNo, isInteractive } from "../../utils/prompts.js";
import {
  REPOS_LAYER_FILENAME,
  readManagedLayer,
  writeManagedLayer,
  type ManagedLayerOptions,
} from "./managed-layer.js";
import type { MissingRepo } from "./resolver.js";
import type { ProviderId } from "./providers/provider.js";
import { enabledRepos } from "./defaults.js";

/** The `addedBy` value meaning a person deliberately added the repository. */
export const USER_ADDED_BY = "user";

/** One repository entry, as it is written into the managed layer. */
export type TrustedRepo = {
  /** Where the repository lives. */
  url: string;
  /** The provider that handles it, when the URL does not give it away. */
  provider?: ProviderId;
  /** Whether a newer in-range version is preferred over the locked one. */
  alwaysPull?: boolean;
  /** When it was added. */
  addedAt?: string;
  /** Who required it: "user", or the ref of the recipe whose dependency pulled it in. */
  addedBy?: string;
};

/** What `addRepo` is told. */
export type AddRepoRequest = {
  /** The repository's short name, which refs use as the `repo:` qualifier. */
  name: string;
  /** Where the repository lives. */
  url: string;
  /** The provider that handles it, when the URL does not give it away. */
  provider?: ProviderId;
  /** Whether a newer in-range version is preferred over the locked one. */
  alwaysPull?: boolean;
  /** Who required it. Defaults to "user". */
  addedBy?: string;
};

/** How trust is confirmed for a round of missing repositories. */
export type ConfirmTrustOptions = {
  /** Whether sous may ask. Defaults to whether both streams are a terminal. */
  interactive?: boolean;
  /** The `--trust` flag: acknowledge every repository this command adds, without asking. */
  trustFlag?: boolean;
};

/** What a confirmation round produced. */
export type ConfirmTrustResult = {
  /** The repositories the user accepted. */
  accepted: MissingRepo[];
  /** The ones whose URL sous knew, and has now written into the managed layer. */
  added: string[];
  /**
   * The ones sous still cannot add on its own, because nothing told it their
   * URL. A recipe names a repository by its short name, so the URL has to come
   * from the person adding it.
   */
  needUrl: string[];
};

/** How the trust service is built. */
export type TrustServiceOptions = ManagedLayerOptions & {
  /** The project's `.sous/` directory; the managed layer lives under it. */
  sousDir: string;
  /** The merged settings, which is where hand-written `repos:` entries come from. */
  settings?: Settings;
  /** Whether sous may ask questions. Defaults to whether both streams are a terminal. */
  interactive?: boolean;
  /** How a yes or no question is asked. Injected in tests. */
  ask?: (message: string) => Promise<boolean>;
  /** Where the consolidated trust notice is written. Defaults to the console. */
  write?: (message: string) => void;
  /** The clock, so a recorded `addedAt` is predictable in tests. */
  now?: () => Date;
};

/** Reads and changes the list of repositories a project trusts. */
export class TrustService {
  private readonly sousDir: string;

  private readonly layerOptions: ManagedLayerOptions;

  private readonly settings: Settings | undefined;

  private readonly interactive: boolean;

  private readonly ask: (message: string) => Promise<boolean>;

  private readonly write: (message: string) => void;

  private readonly now: () => Date;

  constructor(options: TrustServiceOptions) {
    this.sousDir = options.sousDir;
    this.layerOptions = options.confDir === undefined ? {} : { confDir: options.confDir };
    this.settings = options.settings;
    this.interactive = options.interactive ?? isInteractive();
    this.ask = options.ask ?? ((message: string) => askYesNo(message));
    this.write = options.write ?? writeLine;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Every repository the project trusts, keyed by short name. This is the
   * merged view: entries hand-written in the primary config and entries sous
   * wrote into the managed layer both appear, because by the time settings are
   * loaded they are one map.
   *
   * @param settings - The merged settings. Defaults to the ones given at construction.
   */
  listTrusted(settings: Settings | undefined = this.settings): Record<string, TrustedRepo> {
    return { ...enabledRepos(settings) } as Record<string, TrustedRepo>;
  }

  /**
   * True when the project trusts a repository by that name.
   *
   * @param repoName - The repository's short name.
   * @param settings - The merged settings. Defaults to the ones given at construction.
   */
  isTrusted(repoName: string, settings: Settings | undefined = this.settings): boolean {
    return Object.hasOwn(this.listTrusted(settings), repoName);
  }

  /** Every repository written in the managed layer, keyed by short name. */
  listManaged(): Record<string, TrustedRepo> {
    const layer = readManagedLayer(this.sousDir, REPOS_LAYER_FILENAME, this.layerOptions);
    const repos = layer["repos"];
    if (typeof repos !== "object" || repos === null || Array.isArray(repos)) return {};
    return repos as Record<string, TrustedRepo>;
  }

  /**
   * Adds a repository to the managed layer, which is what trusting one means.
   * Adding a name that is already there replaces its entry, so this is also how
   * a URL or a provider is corrected.
   *
   * @param request - The repository's name, URL and provenance.
   */
  addRepo(request: AddRepoRequest): TrustedRepo {
    const existing = this.listManaged();
    const entry: TrustedRepo = {
      url: request.url,
      ...(request.provider === undefined ? {} : { provider: request.provider }),
      ...(request.alwaysPull === undefined ? {} : { alwaysPull: request.alwaysPull }),
      addedAt: this.now().toISOString(),
      addedBy: request.addedBy ?? USER_ADDED_BY,
    };

    writeManagedLayer(
      this.sousDir,
      REPOS_LAYER_FILENAME,
      { repos: { ...existing, [request.name]: entry } },
      this.layerOptions
    );
    return entry;
  }

  /**
   * Removes a repository from the managed layer, withdrawing the trust. A
   * repository written by hand in the primary config is not sous's to remove:
   * that is an error saying so, since silently doing nothing would look like it
   * worked.
   *
   * @param name - The repository's short name.
   */
  removeRepo(name: string): void {
    const existing = this.listManaged();
    if (!Object.hasOwn(existing, name)) {
      if (this.isTrusted(name)) {
        throw new ConfigError(
          `The repository '${name}' is written in this project's own config, not in the ` +
            `layer sous manages.\n` +
            `  Remove its entry from the 'repos' block of your config file; sous never ` +
            `edits a config file you wrote.`
        );
      }
      throw new ConfigError(
        `This project has no repository called '${name}'.\n` +
          `  Run 'sous repo list' to see the repositories it trusts.`
      );
    }

    const remaining = { ...existing };
    delete remaining[name];
    writeManagedLayer(
      this.sousDir,
      REPOS_LAYER_FILENAME,
      { repos: remaining },
      this.layerOptions
    );
  }

  /**
   * Asks about every repository a round of resolution turned up that the
   * project has not added, in ONE consolidated question. Any refusal aborts,
   * because a half-trusted install is not something sous will produce.
   *
   * @param missing - The repositories resolution says are needed.
   * @param options - Whether sous may ask, and whether `--trust` was passed.
   */
  async confirmTrust(
    missing: MissingRepo[],
    options: ConfirmTrustOptions = {}
  ): Promise<ConfirmTrustResult> {
    if (missing.length === 0) return { accepted: [], added: [], needUrl: [] };

    const interactive = options.interactive ?? this.interactive;
    const trustFlag = options.trustFlag ?? false;

    if (!trustFlag && !interactive) {
      throw new ConfigError(this.nonInteractiveMessage(missing));
    }

    if (!trustFlag) {
      this.write(this.trustNotice(missing));
      const plural = missing.length === 1 ? "this repository" : "these repositories";
      const accepted = await this.ask(`Do you trust ${plural}?`);
      if (!accepted) {
        throw new ConfigError(
          `Nothing was installed: trust was declined for ` +
            `${missing.map((repo) => `'${repo.name}'`).join(", ")}.\n` +
            `  Sous installs a dependency closure whole or not at all, so declining any ` +
            `repository in it stops the whole install.`
        );
      }
    }

    const added: string[] = [];
    const needUrl: string[] = [];
    for (const repo of missing) {
      if (repo.url === undefined) {
        needUrl.push(repo.name);
        continue;
      }
      // Every requester is recorded, not just the first. Removal hygiene reads
      // this to say why a repository is there, and a repository three recipes
      // need looks removable when the entry names only one of them.
      const requesters = [
        ...new Set(repo.requiredBy.map((entry) => entry.requestedBy)),
      ].sort();
      this.addRepo({
        name: repo.name,
        url: repo.url,
        addedBy: requesters.length > 0 ? requesters.join(", ") : USER_ADDED_BY,
      });
      added.push(repo.name);
    }

    return { accepted: missing, added, needUrl };
  }

  /**
   * The consolidated notice shown before the question: every new repository,
   * its URL, the recipe that requires it, and what trusting it actually means.
   *
   * @param missing - The repositories being asked about.
   */
  trustNotice(missing: MissingRepo[]): string {
    const lines: string[] = [];
    lines.push(
      color.yellowBright(
        missing.length === 1
          ? "One repository has to be trusted before this can continue."
          : `${missing.length} repositories have to be trusted before this can continue.`
      )
    );
    lines.push("");

    for (const repo of missing) {
      lines.push(`  ${color.bold(repo.name)}`);
      lines.push(
        `    Location:  ${repo.url ?? "not known to sous; a recipe named it by its short name only"}`
      );
      for (const entry of repo.requiredBy) {
        const who = entry.requestedBy === "project" ? "this project" : `'${entry.requestedBy}'`;
        lines.push(`    Required:  ${entry.ref}, by ${who}`);
      }
      lines.push("");
    }

    lines.push("  Trusting a repository trusts every namespace and every recipe in it,");
    lines.push("  including ones published later. Trusting on its own executes nothing;");
    lines.push("  subscribing to something inside it can, and probably will, run scripts");
    lines.push("  on this machine. This question is the last gate before that happens.");
    lines.push("");
    lines.push("  Sous cannot tell you whether a repository deserves trust. Look at the");
    lines.push("  location above, and at who publishes it, before answering.");
    return lines.join("\n");
  }

  /**
   * The error a non-interactive run gets: it names every repository needing
   * trust and the exact command that grants it, because a script cannot answer
   * a question.
   *
   * @param missing - The repositories being asked about.
   */
  private nonInteractiveMessage(missing: MissingRepo[]): string {
    const lines: string[] = [
      missing.length === 1
        ? "One repository has to be trusted before this can continue, and sous is not " +
          "running where it can ask."
        : `${missing.length} repositories have to be trusted before this can continue, ` +
          `and sous is not running where it can ask.`,
      "",
    ];

    for (const repo of missing) {
      const provenance = repo.requiredBy
        .map((entry) => `${entry.ref} (required by ${entry.requestedBy})`)
        .join(", ");
      lines.push(`  ${repo.name}: ${repo.url ?? "URL not known to sous"}`);
      lines.push(`    ${provenance}`);
    }

    lines.push("");
    lines.push("  Trusting a repository trusts every namespace and recipe in it, and");
    lines.push("  subscribing to something inside it can run scripts on this machine.");
    lines.push("  Add each repository deliberately, with its URL:");
    lines.push("");
    for (const repo of missing) {
      lines.push(`    sous repo add ${repo.url ?? "<url>"} --name ${repo.name} --trust`);
    }

    return lines.join("\n");
  }
}

/**
 * Writes a blank line and then a block of text, which is how the trust notice
 * reaches the console when nothing overrides it.
 *
 * @param message - The block to write.
 */
export function writeTrustNotice(message: string): void {
  blankLine();
  writeLine(message);
}
