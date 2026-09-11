/**
 * The provider registry.
 *
 * Import providers from here. This module is the one place that knows which
 * concrete providers sous ships, so `provider.ts` stays free of them and the
 * built-in list has exactly one definition.
 */

import { LocalProvider } from "./local.js";
import { GithubProvider } from "./github.js";
import { GitlabProvider } from "./gitlab.js";
import { IndexCache, type IndexCacheOptions } from "./index-cache.js";
import {
  detectProviderIn,
  providerByIdIn,
  requireProviderIn,
  type RepoProvider,
} from "./provider.js";

// `runGit` is deliberately not re-exported here: `git-clone.ts` exports a `runGit` of its
// own and the repos barrel cannot carry two. Import this one from `providers/git.js` directly.
export { spawnCommand, tryCommand, fetchSubtree } from "./git.js";
export type { CommandResult, CommandRunner, RunOptions } from "./git.js";
export * from "./http.js";
export * from "./provider.js";
export * from "./github.js";
export * from "./gitlab.js";
export * from "./local.js";
export * from "./index-cache.js";

/**
 * The providers sous ships, in the order they are tried. A fresh array every
 * call, so a caller may add to it without affecting anyone else.
 */
export function builtInProviders(): RepoProvider[] {
  // The local provider is last, and matches only a local absolute path or a
  // `file://` URL, so it can never intercept a hosted repository's URL.
  return [new GithubProvider(), new GitlabProvider(), new LocalProvider()];
}

/**
 * Finds the provider that handles a repository URL, or undefined when none
 * does. A repository entry may also name its provider outright, which is what a
 * self-hosted instance behind an unfamiliar host name needs; see
 * `requireProvider`.
 *
 * @param url - The repository URL.
 * @param providers - The providers to consider. Defaults to the built-ins.
 */
export function detectProvider(
  url: string,
  providers: RepoProvider[] = builtInProviders()
): RepoProvider | undefined {
  return detectProviderIn(url, providers);
}

/**
 * Looks a provider up by its identifier, or undefined when there is none.
 *
 * @param id - The provider identifier from a repository entry.
 * @param providers - The providers to consider. Defaults to the built-ins.
 */
export function providerById(
  id: string,
  providers: RepoProvider[] = builtInProviders()
): RepoProvider | undefined {
  return providerByIdIn(id, providers);
}

/**
 * Finds the provider for a repository entry: the one it names, otherwise the
 * one that recognizes its URL. Raises a ConfigError when neither works.
 *
 * @param url - The repository URL.
 * @param providerId - The provider named by the entry, when it named one.
 * @param providers - The providers to consider. Defaults to the built-ins.
 */
export function requireProvider(
  url: string,
  providerId?: string,
  providers: RepoProvider[] = builtInProviders()
): RepoProvider {
  return requireProviderIn(url, providerId, providers);
}

/**
 * Builds an index cache that resolves providers through the built-in list. Pass
 * `resolveProvider` to override that, which is what tests do.
 *
 * @param options - The store root, and anything to override.
 */
export function createIndexCache(
  options: Omit<IndexCacheOptions, "resolveProvider"> &
    Partial<Pick<IndexCacheOptions, "resolveProvider">>
): IndexCache {
  return new IndexCache({
    resolveProvider: (url, providerId) => requireProvider(url, providerId),
    ...options,
  });
}
