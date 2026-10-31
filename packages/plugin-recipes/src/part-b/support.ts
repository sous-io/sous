/**
 * Small helpers part B's modules share.
 */

import type { RepoEntry, RepositoryHostEntity, SubscriptionEntry } from "../types.js";

/**
 * Splits a stored `namespace/recipe` key, as the lockfile and the index write it, at its first `/`.
 *
 * ```ts
 * splitStoredKey("workflow/task-files"); // { namespace: "workflow", name: "task-files" }
 * ```
 */
export function splitStoredKey(key: string): { namespace: string; name: string } {
    const slash = key.indexOf("/");

    return slash === -1 ? { namespace: key, name: "" } : { namespace: key.slice(0, slash), name: key.slice(slash + 1) };
}

/** The segments of a repository identity, as directories: `github.com/sous-io/sous-recipes` gives three. */
export function identitySegments(identity: string): string[] {
    return identity.split("/").filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** The entries of a config map not switched off with `enabled: false`. */
export function enabledEntries<T extends { enabled?: boolean }>(entries: Record<string, T> | undefined): Record<string, T> {
    const kept: Record<string, T> = {};

    for (const [key, entry] of Object.entries(entries ?? {})) {
        if (entry && typeof entry === "object" && entry.enabled !== false) {
            kept[key] = entry;
        }
    }

    return kept;
}

/**
 * The repositories trusted while the config is still being built, when `recipes.trust` (a
 * `config` service) does not exist yet: every `repos` entry not switched off. After the build,
 * part B asks `recipes.trust`.
 */
export function trustedWhileBuilding(repos: Record<string, RepoEntry> | undefined): Record<string, RepoEntry> {
    const kept: Record<string, RepoEntry> = {};

    for (const [name, entry] of Object.entries(enabledEntries(repos))) {
        if (typeof entry.url === "string") {
            kept[name] = entry;
        }
    }

    return kept;
}

/** The subscriptions switched on, by key. */
export function enabledSubscriptions(subscriptions: Record<string, SubscriptionEntry> | undefined): Record<string, SubscriptionEntry> {
    return enabledEntries(subscriptions);
}

/** The `repository-host` that reads a repository: the one its entry names, else the first that matches the URL. */
export function hostFor(hosts: readonly RepositoryHostEntity[], url: string, provider?: string): RepositoryHostEntity | undefined {
    if (provider !== undefined) {
        const named = hosts.find((host) => host.id === provider);

        if (named) {
            return named;
        }
    }

    return hosts.find((host) => {
        try {
            return host.matches(url);
        } catch {
            return false;
        }
    });
}

/** An error's message, whatever was thrown. */
export function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Sorts strings by their UTF-16 code units, the order every listing here uses. */
export function sortKeys(keys: Iterable<string>): string[] {
    return [...keys].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** "1 recipe", "2 recipes". */
export function plural(count: number, one: string, many = `${one}s`): string {
    return `${count} ${count === 1 ? one : many}`;
}
