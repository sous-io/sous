/**
 * The GitLab provider, read path only.
 *
 * The shape is the same as the GitHub provider: the index file is one raw HTTPS
 * GET, and a recipe's subtree comes from git. A token is used when one is
 * available, read from GITLAB_TOKEN or asked of the `glab` command line tool
 * when that is installed and signed in; a missing `glab` is never an error.
 *
 * Self-hosted instances are supported: any host whose name begins with `gitlab.`
 * is recognized automatically, and a repository entry may always name its
 * provider outright for a host that gives nothing away.
 */

import { INDEX_FILENAME } from "../formats/common.js";
import { fetchSubtree, tryCommand, type CommandRunner } from "./git.js";
import { fetchText, type FetchLike } from "./http.js";
import {
  buildCanonicalRepo,
  invalidRepoUrl,
  splitRepoUrl,
  type CanonicalRepo,
  type FetchedIndex,
  type ProviderFeature,
  type ProviderOptions,
  type RepoProvider,
} from "./provider.js";

/** The host this provider serves when a URL does not say otherwise. */
export const GITLAB_HOST = "gitlab.com";

/** The environment variable a GitLab token is read from. */
export const GITLAB_TOKEN_ENV = "GITLAB_TOKEN";

/**
 * Finds a GitLab token: the environment first, then `glab auth token` when the
 * `glab` command line tool is installed and signed in. Returns undefined when
 * there is none, because public repositories need no token at all.
 *
 * @param options - Environment and subprocess runner overrides.
 */
export async function findGitlabToken(options: {
  env?: NodeJS.ProcessEnv;
  run?: CommandRunner;
} = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const fromEnv = env[GITLAB_TOKEN_ENV];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim();
  return tryCommand("glab", ["auth", "token"], { run: options.run });
}

/** The GitLab provider. */
export class GitlabProvider implements RepoProvider {
  readonly id = "gitlab" as const;

  /** Submitting a change arrives with the authoring commands, in a later phase. */
  readonly features: ProviderFeature[] = ["fetch"];

  matches(url: string): boolean {
    const parts = splitRepoUrl(url);
    if (parts === undefined) return false;
    return parts.host === GITLAB_HOST || parts.host.startsWith("gitlab.");
  }

  canonicalize(url: string): CanonicalRepo {
    const parts = splitRepoUrl(url);
    if (parts === undefined) throw invalidRepoUrl(this.id, url);
    return buildCanonicalRepo(parts.host, parts.owner, parts.name);
  }

  /**
   * Fetches the repo's index file from the instance's raw file endpoint at the
   * repository's default branch.
   *
   * @param repo - The canonicalized repository.
   * @param options - Environment, fetch and subprocess overrides.
   */
  async fetchIndex(
    repo: CanonicalRepo,
    options: ProviderOptions = {}
  ): Promise<FetchedIndex> {
    const token = await findGitlabToken({
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.run === undefined ? {} : { run: options.run }),
    });
    const url = this.indexUrl(repo);
    const fetched = await fetchText(url, {
      ...(token === undefined ? {} : { token }),
      ...(options.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.fetchImpl as FetchLike }),
      label: "repo index",
    });

    return fetched.etag === undefined
      ? { text: fetched.text, ref: "HEAD" }
      : { text: fetched.text, ref: "HEAD", etag: fetched.etag };
  }

  /**
   * Fetches one recipe folder at one tag. Private repositories work through
   * git's own credential helpers, the same way a manual clone would.
   *
   * @param repo - The canonicalized repository.
   * @param recipePath - The recipe folder, relative to the repository root.
   * @param tag - The git tag carrying the version.
   * @param destDir - Where the recipe's files should end up.
   * @param options - Subprocess runner override.
   */
  async fetchRecipeTree(
    repo: CanonicalRepo,
    recipePath: string,
    tag: string,
    destDir: string,
    options: ProviderOptions = {}
  ): Promise<void> {
    await fetchSubtree({
      cloneUrl: repo.httpsUrl,
      tag,
      subPath: recipePath,
      destDir,
      ...(options.run === undefined ? {} : { run: options.run }),
    });
  }

  /**
   * The raw URL of a repository's index file at its default branch.
   *
   * @param repo - The canonicalized repository.
   */
  indexUrl(repo: CanonicalRepo): string {
    return `https://${repo.host}/${repo.owner}/${repo.name}/-/raw/HEAD/${INDEX_FILENAME}`;
  }
}
