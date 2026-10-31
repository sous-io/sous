/**
 * Canonical repository identity: what the machine-wide store, the index cache and the lockfile key
 * a repository by.
 *
 * A repository's short name (`sous-recipes`) is a consumer's label. Two projects may call the same
 * repository different things, so a short name never keys anything shared between projects. The
 * identity can: it comes from where the repository lives, so every project on a machine agrees.
 *
 *     github.com/sous-io/sous-recipes
 *     gitlab.example.com/group/subgroup/project
 *     localhost/home/me/Projects/my-recipes
 *
 * The shape is `<host>/<owner path>/<name>`, lowercased, without a `.git` suffix.
 */

import type { CanonicalRepository } from "../types.js";

/** A short name: lowercase kebab case, starting with a letter. */
const SHORT_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * The canonical identity of a repository.
 *
 * ```ts
 * repositoryIdentity({ host: "GitHub.com", owner: "sous-io", name: "sous-recipes", ... });
 * // -> "github.com/sous-io/sous-recipes"
 * ```
 */
export function repositoryIdentity(canonical: Pick<CanonicalRepository, "host" | "owner" | "name">): string {
    const name = canonical.name.replace(/\.git$/i, "");

    return identitySegments(`${canonical.host}/${canonical.owner}/${name}`).join("/");
}

/**
 * The path segments an identity is made of, empty ones dropped and every one lowercased. A local
 * repository's owner is an absolute path, whose leading separator would make an empty segment.
 *
 * ```ts
 * identitySegments("localhost//home/me/recipes"); // -> ["localhost", "home", "me", "recipes"]
 * ```
 */
export function identitySegments(identity: string): string[] {
    return identity
        .split("/")
        .map((segment) => segment.trim().toLowerCase())
        .filter((segment) => segment.length > 0);
}

/**
 * A short name made from an identity, for a repository a project has never added (a dependency's
 * locator, say) before the person has chosen a name for it.
 *
 * ```ts
 * shortNameFromIdentity("github.com/sous-io/sous-recipes"); // -> "sous-recipes"
 * ```
 */
export function shortNameFromIdentity(identity: string): string {
    const segments = identitySegments(identity);
    const last = segments[segments.length - 1] ?? "";
    const cleaned = last
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");

    // A repository whose name starts with a digit, or holds nothing a name may carry, still needs
    // something to be called.
    if (SHORT_NAME.test(cleaned)) {
        return cleaned;
    }

    return cleaned.length === 0 ? "repository" : `repo-${cleaned}`;
}

/** True when two identities name the same repository. Identities are normalized already. */
export function sameRepositoryIdentity(left: string, right: string): boolean {
    return left === right;
}
