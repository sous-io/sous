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
 */

import { ConfigError } from "../../errors.js";
import type { CommandRunner } from "./git.js";
import type { FetchLike } from "./http.js";

/**
 * What a provider can do. `fetch` is the read path every provider implements;
 * `submit` is the propose-a-change path, which arrives in a later phase. A
 * provider declares the feature only once it genuinely supports it.
 */
export type ProviderFeature = "fetch" | "submit";

/** The identifier a repo entry uses to name its provider explicitly. */
export type ProviderId = "github" | "gitlab";

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

/** Options every provider call accepts, all of them for testing seams. */
export type ProviderOptions = {
  /** The environment to read tokens from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** The fetch implementation to use. Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** How subprocesses are run. Defaults to spawning a real process. */
  run?: CommandRunner;
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

/** One repository host sous knows how to read from. */
export interface RepoProvider {
  /** The provider's stable identifier, as written in a repo config entry. */
  readonly id: ProviderId;
  /** What this provider can do; see ProviderFeature. */
  readonly features: ProviderFeature[];
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
 * providers sous knows when neither works.
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
    if (named !== undefined) return named;
    throw new ConfigError(
      `The repository at ${url} names the provider '${providerId}', which sous does not ` +
        `have.\n  Sous ships these providers: ${known}.`
    );
  }

  const detected = detectProviderIn(url, providers);
  if (detected !== undefined) return detected;

  throw new ConfigError(
    `Sous does not recognize the host in the repository URL ${url}.\n` +
      `  Sous ships these providers: ${known}. For a self-hosted instance, name the ` +
      `provider on the repository entry, for example with ` +
      `'sous repo add ${url} --provider gitlab'.`
  );
}
