/**
 * Small helpers part A's modules share.
 */

import type { Context } from "@sous-io/plugin-api";

/** The message of an error, whatever was thrown. */
export function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Bytewise string order, so every listing sorts the same on every machine. */
export function compareBytewise(left: string, right: string): number {
    const a = Buffer.from(left, "utf8");
    const b = Buffer.from(right, "utf8");

    return Buffer.compare(a, b);
}

/** A copy sorted bytewise. */
export function sortBytewise(items: Iterable<string>): string[] {
    return [...items].sort(compareBytewise);
}

/** Whether a value is a plain object (not an array, not null). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A record of entries from a config value that may be missing or malformed. */
export function entryMap<T>(value: unknown): Record<string, T> {
    return isPlainObject(value) ? (value as Record<string, T>) : {};
}

/** A short repository name: lowercase kebab case, starting with a letter. */
export const REPO_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * A short name made from a repository identity, for a repository the project has not named yet.
 *
 * ```ts
 * shortNameFromIdentity("github.com/sous-io/sous-recipes"); // "sous-recipes"
 * ```
 */
export function shortNameFromIdentity(identity: string): string {
    const segments = identity
        .split("/")
        .map((segment) => segment.trim().toLowerCase())
        .filter((segment) => segment.length > 0);
    const cleaned = (segments[segments.length - 1] ?? "")
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "");

    if (REPO_NAME_PATTERN.test(cleaned)) {
        return cleaned;
    }

    return cleaned.length === 0 ? "repository" : `repo-${cleaned}`;
}

/** A short name for an identity that no repository in `taken` uses yet. */
export function proposeRepoName(taken: Iterable<string>, identity: string): string {
    const used = new Set(taken);
    const base = shortNameFromIdentity(identity);

    if (!used.has(base)) {
        return base;
    }

    for (let suffix = 2; ; suffix++) {
        if (!used.has(`${base}-${suffix}`)) {
            return `${base}-${suffix}`;
        }
    }
}

/** Whether an intent is available in this run (another plugin may not be loaded). */
export function hasIntent(ctx: Context, name: string): boolean {
    return ctx.engine.intents.get(name) !== undefined;
}

/** The current time as an ISO 8601 string. */
export function nowIso(): string {
    return new Date().toISOString();
}
