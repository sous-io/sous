/**
 * Canonical repository identity: what the machine-wide store, the index cache
 * and the lockfile key a repository by.
 *
 * A repository's short name (`sous-recipes`) is a CONSUMER's label. Two
 * projects may call the same repository different things, and two different
 * repositories may be called the same thing in two projects, so a short name
 * can never key anything shared between projects. The identity can: it is
 * derived from the location the repository actually lives at, so every project
 * on a machine agrees about it.
 *
 *     github.com/sous-io/sous-recipes
 *     gitlab.example.com/group/subgroup/project
 *     localhost/home/me/Projects/my-recipes
 *
 * The shape is `<host>/<owner path>/<name>`, lowercased, with any `.git`
 * suffix already gone (the providers strip it while canonicalizing). Short
 * names stay exactly where they were: in a project's config, in its lockfile
 * keys, and in everything sous prints, because that is what a person typed.
 */

import type { CanonicalRepo } from "./providers/provider.js";
import { REPO_NAME_PATTERN } from "./formats/patterns.js";

/**
 * The canonical identity of a repository, as every machine-wide key spells it.
 *
 * repoIdentity({ host: "GitHub.com", owner: "sous-io", name: "sous-recipes" });
 * // -> "github.com/sous-io/sous-recipes"
 *
 * @param canonical - The repository, taken apart by its provider.
 */
export function repoIdentity(canonical: CanonicalRepo): string {
  const name = canonical.name.replace(/\.git$/i, "");
  return identitySegments(`${canonical.host}/${canonical.owner}/${name}`).join("/");
}

/**
 * The path segments an identity is made of, with empty segments dropped and
 * every segment lowercased. A local repository's owner is an absolute path, so
 * its leading separator would otherwise produce an empty first segment.
 *
 * identitySegments("localhost//home/me/recipes");
 * // -> ["localhost", "home", "me", "recipes"]
 *
 * @param identity - The identity, or the pieces of one joined with slashes.
 */
export function identitySegments(identity: string): string[] {
  return identity
    .split("/")
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment.length > 0);
}

/**
 * A short name derived from an identity, used when sous has to name a
 * repository a project has never added (a dependency's locator URL, for
 * instance) before the person has chosen a name for it.
 *
 * shortNameFromIdentity("github.com/sous-io/sous-recipes"); // -> "sous-recipes"
 *
 * @param identity - The repository's canonical identity.
 */
export function shortNameFromIdentity(identity: string): string {
  const segments = identitySegments(identity);
  const last = segments[segments.length - 1] ?? "";
  const cleaned = last
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  // A short name is lowercase kebab-case starting with a letter. A repository
  // whose name starts with a digit, or is made entirely of characters a name
  // may not carry, still needs something to be called.
  if (REPO_NAME_PATTERN.test(cleaned)) return cleaned;
  return cleaned.length === 0 ? "repository" : `repo-${cleaned}`;
}

/**
 * True when two identities name the same repository. Identities are already
 * normalized, so this is a plain comparison; it exists so callers read as what
 * they mean rather than as a string equality.
 *
 * @param left - One identity.
 * @param right - The other.
 */
export function sameRepoIdentity(left: string, right: string): boolean {
  return left === right;
}
