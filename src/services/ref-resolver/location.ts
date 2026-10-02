/**
 * Building a `RefLocation`: where a repository lives, in the form every ref
 * and every machine-wide key agrees on.
 */

import { repoIdentity } from "../../lib/repos/identity.js";
import {
  requireProvider,
  type RepoProvider,
} from "../../lib/repos/providers/index.js";
import type { RefLocation } from "./types.js";

/**
 * Where one repository lives, or undefined when its provider cannot take the
 * path apart (a path of one segment, say).
 *
 * @param provider - The provider that reads the location.
 * @param host - The repository's host.
 * @param repoPath - The repository's path on that host.
 */
export function locationFor(
  provider: RepoProvider,
  host: string,
  repoPath: string
): RefLocation | undefined {
  const url = `https://${host}/${repoPath}`;
  try {
    return {
      provider: provider.id,
      host,
      repoPath,
      identity: repoIdentity(provider.canonicalize(url)),
      url,
    };
  } catch {
    return undefined;
  }
}

/**
 * Where the repository at a configured URL lives, or undefined when no
 * provider recognizes it. The location's `url` is the URL as the project
 * configured it, which is what a person is shown.
 *
 * @param url - The repository's URL, as a project's config records it.
 * @param providers - The providers to ask. Defaults to the built-ins.
 */
export function locationFromUrl(url: string, providers?: RepoProvider[]): RefLocation | undefined {
  try {
    const provider = requireProvider(url, undefined, providers);
    const canonical = provider.canonicalize(url);
    return {
      provider: provider.id,
      host: canonical.host,
      repoPath: `${canonical.owner}/${canonical.name}`,
      identity: repoIdentity(canonical),
      url,
    };
  } catch {
    return undefined;
  }
}
