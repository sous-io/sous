/**
 * The provider interface.
 *
 * A provider knows how to talk to one kind of repository host. Version one
 * ships exactly two, GitHub and GitLab, and the interface stays INTERNAL: it is
 * not a published plugin API yet, so it can still change shape while the rest
 * of the Repositories system settles.
 *
 * A provider does only two things on the read path, and both are deliberately
 * small: hand back a repo's index file, and fetch one recipe's subtree at one
 * tag. Anything larger (a full clone) belongs to the authoring workflow, not to
 * installing recipes.
 *
 * The write path is just as small, and it is the ONLY place a host's own
 * mechanics are allowed to live. Everything host-specific (which command line
 * tool is driven, how a fork is made, what a proposal is called, how one is
 * opened) belongs to a provider; the services above it ask in order and report
 * what came back. A provider declares `submit` in its features once it answers
 * the write side; one that does not may leave those methods out entirely, and
 * `ProviderBase` answers them with a clear refusal naming the provider and the
 * feature.
 */

import { ConfigError } from "../../errors.js";
import type { CommandRunner } from "./git.js";
import type { FetchLike } from "./http.js";

/**
 * What a provider can do. `fetch` is the read path every provider implements;
 * `submit` is the propose-a-change path; `proposals` is looking a proposal up
 * again afterwards (finding the one a branch already has, reporting its status,
 * and replacing its title or body), which is what lets `sous repo submit`
 * handle a proposal's whole life rather than only its first day. A provider
 * declares a feature only once it genuinely supports it.
 */
export type ProviderFeature = "fetch" | "submit" | "proposals";

/**
 * The identifier a repo entry uses to name its provider explicitly. `local` is a
 * repository on this machine, for local development and for tests; its trust
 * semantics are identical to a hosted one.
 */
export type ProviderId = "github" | "gitlab" | "local";

/** A repository URL, taken apart into the pieces every provider needs. */
export type CanonicalRepo = {
  /** The host the repository lives on, such as `github.com`. */
  host: string;
  /** The owning user, organization or group path. */
  owner: string;
  /** The repository's own name, with any `.git` suffix removed. */
  name: string;
  /** The canonical HTTPS clone URL. */
  httpsUrl: string;
  /** The canonical SSH clone URL. */
  sshUrl: string;
};

/**
 * A location as written in a ref, taken apart only as far as every host agrees:
 * the host, and the path segments after it. Which of those segments are the
 * repository and which name something inside it is a host's own rule, so a
 * provider answers that (see `RepoProvider.readLocation`).
 *
 *     https://gitlab.com/group/sub/project/-/tree/main/recipes/workflow/alpha
 *     // -> { host: "gitlab.com",
 *     //      segments: ["group", "sub", "project", "-", "tree", "main", ...] }
 */
export type WrittenLocation = {
  /** The host, lowercased, such as `github.com`. */
  host: string;
  /** Every path segment after the host, in order, none of them empty. */
  segments: string[];
};

/**
 * One way a provider reads a written location. A location on a host where a
 * repository path can be any length (a GitLab group nests) may have several.
 */
export type LocationReading = {
  /** The repository's path on the host, such as `sous-io/sous-recipes`, with no `.git`. */
  repoPath: string;
  /**
   * The segments after the repository that name something inside it: a
   * namespace, a namespace and a recipe, or a namespace and `*`. Empty when the
   * location names only the repository.
   */
  named?: string[];
  /**
   * A browser URL's path inside the repository, copied from a host's file view
   * (after `tree/` or `blob/`), with the branch still in front of it. It is
   * settled against the `path` each recipe's index entry records.
   */
  browsed?: string;
};

/** Options every provider call accepts, all of them for testing seams. */
export type ProviderOptions = {
  /**
   * The directory subprocesses run in. A write-path call is made from inside
   * the contributor's checkout, so the host's own command line tool reads the
   * repository the contributor is standing in.
   */
  cwd?: string;
  /** The environment to read tokens from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The fetch implementation to use. Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** How subprocesses are run. Defaults to spawning a real process. */
  run?: CommandRunner;
  /** Cancels an index request, for a caller that will not wait past a deadline. */
  signal?: AbortSignal;
};

/** What an index fetch returns. */
export type FetchedIndex = {
  /** The raw text of the index file, still to be parsed and validated. */
  text: string;
  /** The git ref the file was read at, for the record. */
  ref: string;
  /** The entity tag the host sent, when it sent one. */
  etag?: string;
};

/** What a provider's command line tool is called, and where to get it. */
export type ProviderCli = {
  /** The executable, spelled the way it is typed. */
  command: string;
  /** The plain-language name used in messages, such as `the GitHub CLI`. */
  label: string;
  /** Where the tool is installed from, for the message that says it is missing. */
  install: string;
};

/** What an authentication check found. */
export type AuthStatus = {
  /** True when sous can act on the contributor's behalf here. */
  ok: boolean;
  /**
   * One plain-language explanation, ready to print: what is signed in when the
   * check passed, and what to install or run when it did not.
   */
  detail: string;
};

/** Where a fork of a repository ended up. */
export type ForkedRepo = {
  /** The account the fork lives under. */
  owner: string;
  /** The fork's repository name. */
  name: string;
  /** The fork's HTTPS clone URL. */
  httpsUrl: string;
  /** The fork's SSH clone URL. */
  sshUrl: string;
};

/** One change, described the way every provider needs to hear about it. */
export type ChangeProposal = {
  /** The branch the change is on. */
  branch: string;
  /** The branch the proposal targets, when the caller knows it. */
  base?: string;
  /** The proposal's title. */
  title: string;
  /** The proposal's body. */
  body: string;
  /** True when the proposal should be opened as a draft. */
  draft: boolean;
  /**
   * The account the branch was pushed to, when that is not the repository
   * itself. Only a provider knows how a cross-repository proposal is spelled,
   * so it is handed the owner and composes the rest.
   */
  head?: { owner: string };
};

/** What proposing a change produced. */
export type ProposedChange = {
  /** The proposal's address, when the provider gave one. */
  url?: string;
  /** One plain-language line about what happened, ready to print. */
  detail: string;
};

/** Where a proposal stands: still open, merged, or closed without merging. */
export type ProposalState = "open" | "merged" | "closed";

/** One proposal, as plain data every provider can describe. */
export type ProposalSummary = {
  /** How the provider identifies it, such as a pull request number. */
  id: string;
  /** Its address, when the provider reported one. */
  url?: string;
  /** Where it stands. */
  state: ProposalState;
  /** Its current title. */
  title: string;
  /** True when it is a draft. */
  draft: boolean;
  /** The branch it targets, when the provider reported it. */
  base?: string;
};

/** Which proposal to look for: the one a branch was pushed for. */
export type ProposalQuery = {
  /** The branch the change is on. */
  branch: string;
  /**
   * True when the branch lives on a fork rather than in the repository itself.
   * A proposal from a fork is found by the fork's owner as well as the branch,
   * so two contributors' branches of the same name are never confused.
   */
  fromFork: boolean;
  /**
   * The account the fork lives under, when the caller knows it. Left out, the
   * provider asks the host which account is signed in.
   */
  forkOwner?: string;
};

/** How a proposal's review is going, in words every host can be mapped onto. */
export type ProposalReview = "approved" | "changes requested" | "review required";

/** How the automated checks on a proposal stand, counted. */
export type ProposalChecks = {
  passed: number;
  failed: number;
  pending: number;
};

/** Everything a status report says about one proposal. */
export type ProposalStatus = {
  /** The proposal itself. */
  proposal: ProposalSummary;
  /** How its review is going, when the host reports it. */
  review?: ProposalReview;
  /** How its checks stand, when it has any. */
  checks?: ProposalChecks;
  /** Whether it can be merged as it stands; undefined when the host is still working it out. */
  mergeable?: boolean;
};

/** What to replace on an open proposal. A field left out is left as it is. */
export type ProposalUpdate = {
  title?: string;
  body?: string;
};

/** One repository host sous knows how to read from. */
export interface RepoProvider {
  /** The provider's stable identifier, as written in a repo config entry. */
  readonly id: ProviderId;
  /** What this provider can do; see ProviderFeature. */
  readonly features: ProviderFeature[];
  /**
   * The host a locator such as `github://owner/repo/...` means when it names
   * none. A provider without a public host of its own leaves it out.
   */
  readonly defaultHost?: string;
  /**
   * Every way this provider reads a location inside one of its repositories:
   * where the repository path ends, and whether the rest names a namespace, a
   * recipe or a browser path. An empty list means the provider reads no such
   * location.
   */
  readLocation(location: WrittenLocation): LocationReading[];
  /**
   * The canonical locator for something inside one of this provider's
   * repositories, which is how sous prints a located ref.
   *
   * @param host - The repository's host.
   * @param repoPath - The repository's path on that host.
   * @param rest - What is named inside it, such as `workflow/alpha`.
   */
  formatLocator(host: string, repoPath: string, rest: string): string;
  /** True when this provider handles the given repository URL. */
  matches(url: string): boolean;
  /** Takes a repository URL apart, raising a ConfigError when it does not fit. */
  canonicalize(url: string): CanonicalRepo;
  /** Fetches the repo's `sous.index.json` at its default branch. */
  fetchIndex(repo: CanonicalRepo, options?: ProviderOptions): Promise<FetchedIndex>;
  /**
   * Fetches ONE recipe's subtree at one tag into `destDir`, never the whole
   * repository.
   *
   * @param repo - The canonicalized repository.
   * @param recipePath - The recipe folder's path, relative to the repo root.
   * @param tag - The git tag carrying the version to fetch.
   * @param destDir - Where the recipe's files should end up.
   * @param options - Testing seams.
   */
  fetchRecipeTree(
    repo: CanonicalRepo,
    recipePath: string,
    tag: string,
    destDir: string,
    options?: ProviderOptions
  ): Promise<void>;

  // --- The write path, answered by a provider that declares `submit` --------

  /** The command line tool this provider drives, when it has one. */
  readonly cli?: ProviderCli;
  /**
   * What this provider calls a proposal, such as `pull request` or `merge
   * request`. It is what the submission prints as it goes.
   */
  readonly proposalNoun?: string;
  /** Whether sous can act on the contributor's behalf here, and why not. */
  authStatus?(options?: ProviderOptions): Promise<AuthStatus>;
  /**
   * Whether the contributor may push to the repository itself. Undefined means
   * the provider genuinely cannot tell, which is not the same as `false`.
   */
  canPush?(repo: CanonicalRepo, options?: ProviderOptions): Promise<boolean | undefined>;
  /** Forks the repository onto the contributor's own account. */
  fork?(repo: CanonicalRepo, options?: ProviderOptions): Promise<ForkedRepo>;
  /** Opens a proposal for a branch that has already been pushed. */
  proposeChange?(
    repo: CanonicalRepo,
    proposal: ChangeProposal,
    options?: ProviderOptions
  ): Promise<ProposedChange>;

  // --- Proposals after the fact, answered by a provider that declares `proposals`

  /**
   * The proposal a branch was pushed for, or undefined when it has none. When a
   * branch has had several, the open one wins, and otherwise the newest.
   */
  findProposal?(
    repo: CanonicalRepo,
    query: ProposalQuery,
    options?: ProviderOptions
  ): Promise<ProposalSummary | undefined>;
  /** Where one proposal stands: its state, its review and its checks. */
  proposalStatus?(
    repo: CanonicalRepo,
    id: string,
    options?: ProviderOptions
  ): Promise<ProposalStatus>;
  /** Replaces an open proposal's title, its body, or both. */
  updateProposal?(
    repo: CanonicalRepo,
    id: string,
    update: ProposalUpdate,
    options?: ProviderOptions
  ): Promise<ProposedChange>;
}

/**
 * A provider that can find a proposal again, report on it and change its text.
 * This is what declaring the `proposals` feature promises.
 */
export type ProposalCapableProvider = RepoProvider &
  Required<Pick<RepoProvider, "findProposal" | "proposalStatus" | "updateProposal">>;

/**
 * True when a provider declares the `proposals` feature and really does answer
 * all three calls behind it.
 *
 * @param provider - The provider to test.
 */
export function supportsProposals(
  provider: RepoProvider
): provider is ProposalCapableProvider {
  return (
    provider.features.includes("proposals") &&
    typeof provider.findProposal === "function" &&
    typeof provider.proposalStatus === "function" &&
    typeof provider.updateProposal === "function"
  );
}

/**
 * A provider that answers the whole write path. This is what declaring the
 * `submit` feature promises, and `supportsSubmit` is how a caller gets from the
 * one to the other without ever naming a provider.
 */
export type SubmitCapableProvider = RepoProvider &
  Required<Pick<RepoProvider, "authStatus" | "canPush" | "fork" | "proposeChange">>;

/**
 * True when a provider declares the `submit` feature and really does answer
 * every write-path call. It narrows the type, so a caller that has asked once
 * never has to test a method for existence again.
 *
 * @param provider - The provider to test.
 */
export function supportsSubmit(provider: RepoProvider): provider is SubmitCapableProvider {
  return (
    provider.features.includes("submit") &&
    typeof provider.authStatus === "function" &&
    typeof provider.canPush === "function" &&
    typeof provider.fork === "function" &&
    typeof provider.proposeChange === "function"
  );
}

/** The words a host's file view puts between a repository and a path: `tree/` and `blob/`. */
const BROWSE_WORDS = new Set(["tree", "blob"]);

/**
 * A repository's last path segment without a `.git` suffix.
 *
 * @param segment - The segment as written.
 */
export function withoutGitSuffix(segment: string): string {
  return segment.replace(/\.git$/i, "");
}

/**
 * Every reading of the segments after a repository: what they name, and, when
 * they start with `tree/` or `blob/`, the browser path they could also be. Both
 * are returned when both are possible (a namespace could be called `tree`), and
 * the caller keeps the one the repository's index confirms. A leading `-`
 * segment (GitLab's separator between a project and its pages) is dropped
 * first, wherever it is written.
 *
 * readingsAfterRepository("o/r", ["tree", "main", "recipes", "workflow", "alpha"]);
 * // -> [{ repoPath: "o/r", browsed: "main/recipes/workflow/alpha" },
 * //     { repoPath: "o/r", named: ["tree", "main", "recipes", "workflow", "alpha"] }]
 *
 * @param repoPath - The repository's path on its host.
 * @param rest - The segments after it.
 */
export function readingsAfterRepository(repoPath: string, rest: string[]): LocationReading[] {
  const after = rest[0] === "-" ? rest.slice(1) : rest;
  const readings: LocationReading[] = [];
  if (after.length >= 2 && BROWSE_WORDS.has(after[0]!.toLowerCase())) {
    readings.push({ repoPath, browsed: after.slice(1).join("/") });
  }
  readings.push({ repoPath, named: after });
  return readings;
}

/**
 * Normalizes a repository URL for matching: trims it, drops a trailing slash
 * and a trailing `.git`, and lowercases the scheme and host only.
 *
 * @param url - The URL as configured.
 */
export function normalizeRepoUrl(url: string): string {
  let value = url.trim();
  while (value.endsWith("/")) value = value.slice(0, -1);
  if (value.endsWith(".git")) value = value.slice(0, -4);
  return value;
}

/**
 * Takes a repository URL apart into host, owner and name. Accepts the HTTPS
 * form, the `scp`-style SSH form (`git@host:owner/name.git`) and the
 * `ssh://host/owner/name` form, because all three are what people paste.
 *
 * Returns undefined rather than throwing, so a provider's `matches` can use it.
 *
 * @param url - The URL as configured.
 */
export function splitRepoUrl(
  url: string
): { host: string; owner: string; name: string } | undefined {
  const normalized = normalizeRepoUrl(url);
  if (normalized.length === 0) return undefined;

  let host: string;
  let repoPath: string;

  const scpMatch = /^(?:([^@\s/]+)@)?([^@\s/:]+):(.+)$/.exec(normalized);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(normalized)) {
    let parsed: URL;
    try {
      parsed = new URL(normalized);
    } catch {
      return undefined;
    }
    host = parsed.host.toLowerCase();
    repoPath = parsed.pathname.replace(/^\/+/, "");
  } else if (scpMatch !== null) {
    host = scpMatch[2]!.toLowerCase();
    repoPath = scpMatch[3]!.replace(/^\/+/, "");
  } else {
    return undefined;
  }

  const segments = repoPath.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2 || host.length === 0) return undefined;

  const name = segments[segments.length - 1]!;
  const owner = segments.slice(0, -1).join("/");
  return { host, owner, name };
}

/**
 * Builds the canonical form of a repository URL for a given host style.
 *
 * @param host - The repository host.
 * @param owner - The owning user, organization or group path.
 * @param name - The repository name.
 */
export function buildCanonicalRepo(
  host: string,
  owner: string,
  name: string
): CanonicalRepo {
  return {
    host,
    owner,
    name,
    httpsUrl: `https://${host}/${owner}/${name}.git`,
    sshUrl: `git@${host}:${owner}/${name}.git`,
  };
}

/**
 * Raises the standard ConfigError for a URL a provider cannot take apart.
 *
 * @param providerId - Which provider rejected it.
 * @param url - The offending URL.
 */
export function invalidRepoUrl(providerId: ProviderId, url: string): ConfigError {
  return new ConfigError(
    `'${url}' is not a ${providerId} repository URL that sous can read.\n` +
      `  A repository URL names an owner and a repository, as in ` +
      `'https://${providerId}.com/owner/repository'.`
  );
}

/**
 * Finds the provider that handles a repository URL among the ones given, or
 * undefined when none does. `providers/index.ts` wraps this with the built-in
 * provider list, which is what callers normally use.
 *
 * @param url - The repository URL.
 * @param providers - The providers to consider.
 */
export function detectProviderIn(
  url: string,
  providers: RepoProvider[]
): RepoProvider | undefined {
  return providers.find((provider) => provider.matches(url));
}

/**
 * Looks a provider up by its identifier among the ones given, or undefined when
 * there is none.
 *
 * @param id - The provider identifier from a repo config entry.
 * @param providers - The providers to consider.
 */
export function providerByIdIn(
  id: string,
  providers: RepoProvider[]
): RepoProvider | undefined {
  return providers.find((provider) => provider.id === id);
}

/**
 * Finds the provider for a repo entry: the one it names, otherwise the one that
 * recognizes its URL. Raises a ConfigError naming the URL and listing the
 * providers sous knows when neither works, and another when the named provider
 * contradicts a URL a different provider plainly owns.
 *
 * @param url - The repository URL.
 * @param providerId - The provider named by the repo entry, when it named one.
 * @param providers - The providers to consider.
 */
export function requireProviderIn(
  url: string,
  providerId: string | undefined,
  providers: RepoProvider[]
): RepoProvider {
  const known = providers.map((entry) => entry.id).join(", ");

  if (providerId !== undefined) {
    const named = providerByIdIn(providerId, providers);
    if (named === undefined) {
      throw new ConfigError(
        `The repository at ${url} names the provider '${providerId}', which sous does not ` +
          `have.\n  Sous ships these providers: ${known}.`
      );
    }

    // A named provider is honoured for a host nobody recognizes, which is what a
    // self-hosted instance needs. It is refused only when a DIFFERENT provider
    // plainly owns the URL, because that is a contradiction rather than a hint.
    if (!named.matches(url)) {
      const owner = detectProviderIn(url, providers);
      if (owner !== undefined) {
        throw new ConfigError(
          `The ${named.id} provider does not handle ${url}; that is ` +
            `${describeRepoUrl(owner.id)}, which the ${owner.id} provider handles.\n` +
            `  Drop '--provider' and let sous work it out, or name '${owner.id}'.`
        );
      }
    }

    return named;
  }

  const detected = detectProviderIn(url, providers);
  if (detected !== undefined) return detected;

  throw new ConfigError(
    `Sous does not recognize the host in the repository URL ${url}.\n` +
      `  Sous ships these providers: ${known}. For a self-hosted instance, name the ` +
      `provider that host runs on the repository entry, as in ` +
      `'sous repo add ${url} --provider <provider>'.`
  );
}

/** How a URL a provider recognizes is described in a mismatch message. */
function describeRepoUrl(providerId: ProviderId): string {
  return providerId === "local" ? "a local path" : `a ${providerId} URL`;
}
