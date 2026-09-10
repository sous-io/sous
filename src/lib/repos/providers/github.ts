/**
 * The GitHub provider, read path only.
 *
 * Reading a repo needs no GitHub API and no `gh`: the index file is one raw
 * HTTPS GET, and a recipe's subtree comes from git itself. A token is used when
 * one is available, so private repositories work; it is read from GITHUB_TOKEN,
 * or asked of the `gh` command line tool when that is installed and signed in.
 * A missing `gh` is never an error.
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
export const GITHUB_HOST = "github.com";

/** The environment variable a GitHub token is read from. */
export const GITHUB_TOKEN_ENV = "GITHUB_TOKEN";

/**
 * Finds a GitHub token: the environment first, then `gh auth token` when the
 * `gh` command line tool is installed and signed in. Returns undefined when
 * there is none, because public repositories need no token at all.
 *
 * @param options - Environment and subprocess runner overrides.
 */
export async function findGithubToken(options: {
  env?: NodeJS.ProcessEnv;
  run?: CommandRunner;
} = {}): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const fromEnv = env[GITHUB_TOKEN_ENV];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim();
  return tryCommand("gh", ["auth", "token"], { run: options.run });
}

/** The GitHub provider. */
export class GithubProvider implements RepoProvider {
  readonly id = "github" as const;

  /** Submitting a change arrives with the authoring commands, in a later phase. */
  readonly features: ProviderFeature[] = ["fetch"];

  matches(url: string): boolean {
    const parts = splitRepoUrl(url);
    return parts !== undefined && parts.host === GITHUB_HOST;
  }

  canonicalize(url: string): CanonicalRepo {
    const parts = splitRepoUrl(url);
    if (parts === undefined) throw invalidRepoUrl(this.id, url);
    return buildCanonicalRepo(parts.host, parts.owner, parts.name);
  }

  /**
   * Fetches the repo's index file from the raw content host at the repository's
   * default branch, which is what `HEAD` names there.
   *
   * @param repo - The canonicalized repository.
   * @param options - Environment, fetch and subprocess overrides.
   */
  async fetchIndex(
    repo: CanonicalRepo,
    options: ProviderOptions = {}
  ): Promise<FetchedIndex> {
    const token = await findGithubToken({
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
    return `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/HEAD/${INDEX_FILENAME}`;
  }
}
