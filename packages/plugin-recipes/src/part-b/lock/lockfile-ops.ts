/**
 * Pure operations on a lockfile: applying a resolution, dropping a holder, walking holders, and
 * comparing two lockfiles. Nothing here reads or writes a file.
 *
 * Removal is refcounted: every entry lists who holds it, and an entry goes only when its last
 * holder does, so dropping one recipe never removes something another recipe still needs.
 */

import { ConfigError } from "@sous-io/plugin-api";
import type { LockedRecipe, Lockfile } from "@sous-io/plugin-formats/types";
import type { LockChange, LockDiff, ResolvedRecipe } from "../../types.js";
import { PROJECT_HOLDER } from "../constants.js";
import { sortKeys } from "../support.js";

/** What the lockfile needs to know about a repository a resolution used. */
export interface LockRepoInput {
    url: string;
    /** Its canonical identity; worked out by the caller when left out. */
    identity?: string;
    /** The hash of the index the resolution was made against. */
    indexHash?: LockedRecipe["hash"];
}

/** A lockfile with nothing in it. */
export function emptyLockfile(): Lockfile {
    return { formatVersion: 1, repos: {}, recipes: {} };
}

/** One version a locked entry pins: the shared one (no `holder`), or one pinned for a single holder. */
export interface LockedVersion {
    readonly version: string;
    readonly hash: LockedRecipe["hash"];
    /** The holder this version is pinned for alone. */
    readonly holder?: string;
}

/**
 * Every version a locked entry pins: the shared `version` first, then each holder's own pin
 * (ADR 0023, decision 4), by holder. Each one is fetched, verified and kept in the store.
 *
 * ```ts
 * lockedVersions({ version: "2.0.0", hash, pins: { "workflow/a": { version: "1.0.0", hash: other } }, ... });
 * // [{ version: "2.0.0", hash }, { version: "1.0.0", hash: other, holder: "workflow/a" }]
 * ```
 */
export function lockedVersions(entry: LockedRecipe): LockedVersion[] {
    return [
        { version: entry.version, hash: entry.hash },
        ...sortKeys(Object.keys(entry.pins ?? {})).map((holder) => ({ ...(entry.pins as NonNullable<LockedRecipe["pins"]>)[holder]!, holder })),
    ];
}

/**
 * How a restore names one locked version: the key for the shared one, and the key, version and
 * holder for one pinned for a single holder.
 *
 * ```ts
 * restoredLabel("workflow/shared", { version: "1.0.0", hash, holder: "workflow/a" });
 * // "workflow/shared version 1.0.0 for workflow/a"
 * ```
 */
export function restoredLabel(key: string, locked: LockedVersion): string {
    return locked.holder === undefined ? key : `${key} version ${locked.version} for ${locked.holder}`;
}

/** The version a holder uses of a locked entry: its own pin, else the shared one. */
export function versionFor(entry: LockedRecipe, holder: string): LockedVersion {
    const pin = entry.pins?.[holder];

    return pin === undefined ? { version: entry.version, hash: entry.hash } : { ...pin, holder };
}

/**
 * The versions a resolve holds while every range allows them: each locked entry's shared version
 * (`keep`) and each holder's own pin (`keepPins`), leaving out the keys in `except`.
 *
 * ```ts
 * heldVersions(lock, ["workflow/moved"]); // { keep: { "workflow/a": "1.2.0" }, keepPins: {} }
 * ```
 */
export function heldVersions(lock: Lockfile, except: Iterable<string> = []): { keep: Record<string, string>; keepPins: Record<string, Record<string, string>> } {
    const skipped = new Set(except);
    const keep: Record<string, string> = {};
    const keepPins: Record<string, Record<string, string>> = {};

    for (const [key, entry] of Object.entries(lock.recipes)) {
        if (skipped.has(key)) {
            continue;
        }

        keep[key] = entry.version;

        if (entry.pins !== undefined && Object.keys(entry.pins).length > 0) {
            keepPins[key] = Object.fromEntries(Object.entries(entry.pins).map(([holder, pin]) => [holder, pin.version]));
        }
    }

    return { keep, keepPins };
}

/** A locked entry held only by some holders, its per-holder pins trimmed to match. */
export function withHolders(entry: LockedRecipe, holders: readonly string[]): LockedRecipe {
    const { pins: previous, ...rest } = entry;
    const pins = Object.fromEntries(Object.entries(previous ?? {}).filter(([holder]) => holders.includes(holder)));

    return { ...rest, requestedBy: [...holders], ...(Object.keys(pins).length === 0 ? {} : { pins: sortObjectKeys(pins) }) };
}

/** A copy of an object with its keys sorted. */
function sortObjectKeys<T>(value: Record<string, T>): Record<string, T> {
    return Object.fromEntries(sortKeys(Object.keys(value)).map((key) => [key, value[key] as T]));
}

/** A copy of a recipe map with its keys in sorted order. */
export function sortRecipes(recipes: Record<string, LockedRecipe>): Record<string, LockedRecipe> {
    const sorted: Record<string, LockedRecipe> = {};

    for (const key of sortKeys(Object.keys(recipes))) {
        sorted[key] = recipes[key];
    }

    return sorted;
}

/**
 * The lockfile a resolution implies. A recipe the resolution covered takes its version and hash;
 * anything it did not mention is carried through untouched. Holders are merged, never replaced:
 * a resolution only walks the closure it was asked about, so replacing would erase holds recorded
 * by an earlier one. `kind` merges the same way. A holder the resolution covered takes the pin it
 * settled (or none, when it shares the version); a holder it did not cover keeps its pin.
 *
 * ```ts
 * applyResolution(lock, resolved, { "sous-recipes": { url: "https://github.com/sous-io/sous-recipes" } });
 * ```
 *
 * @param identityOf - Works out an identity for a repository given none, from its URL.
 */
export function applyResolution(
    lock: Lockfile,
    resolved: readonly ResolvedRecipe[],
    repos: Readonly<Record<string, LockRepoInput>>,
    identityOf: (url: string) => string | undefined = () => undefined,
): Lockfile {
    const recipes: Record<string, LockedRecipe> = { ...lock.recipes };

    for (const recipe of resolved) {
        const previous = lock.recipes[recipe.key];
        const holders = new Set([...(previous?.requestedBy ?? []), ...recipe.requestedBy]);
        const pins: NonNullable<LockedRecipe["pins"]> = {};

        for (const [holder, pin] of Object.entries(previous?.pins ?? {})) {
            if (!recipe.requestedBy.includes(holder)) {
                pins[holder] = pin;
            }
        }

        for (const pin of recipe.pins ?? []) {
            pins[pin.holder] = { version: pin.version, hash: pin.hash };
        }

        recipes[recipe.key] = withHolders(
            {
                repo: recipe.repo,
                version: recipe.version,
                hash: recipe.hash,
                requestedBy: [],
                kind: previous?.kind === "subscribes" || recipe.kind === "subscribes" ? "subscribes" : "depends",
                pins,
            },
            sortKeys(holders),
        );
    }

    const lockedRepos: Lockfile["repos"] = {};

    for (const name of usedRepos(recipes)) {
        const known = repos[name];
        const previous = lock.repos[name];
        const url = known?.url ?? previous?.url;

        if (url === undefined) {
            throw new ConfigError(`The lockfile cannot record the recipes from '${name}' because nothing knows that repository's URL.`, {
                details: ["Add it with 'sous repo add <url>', so the lockfile can name where its recipes came from."],
            });
        }

        const identity = known?.identity ?? previous?.identity ?? identityOf(url);
        const indexHash = known?.indexHash ?? previous?.indexHash;

        lockedRepos[name] = {
            url,
            ...(identity === undefined ? {} : { identity }),
            ...(indexHash === undefined ? {} : { indexHash }),
        };
    }

    return { formatVersion: 1, repos: lockedRepos, recipes: sortRecipes(recipes) };
}

/**
 * Drops one holder. Every recipe that holder pulled in loses it too, and an entry goes only once
 * nothing holds it, repeating until a pass changes nothing.
 *
 * @param holder - `project`, or a recipe key.
 * @param label - The lockfile's path, for the error a damaged file gives.
 */
export function removeHolder(lock: Lockfile, holder: string, label = LOCKFILE_LABEL): Lockfile {
    const recipes: Record<string, LockedRecipe> = {};

    for (const [key, entry] of Object.entries(lock.recipes)) {
        recipes[key] = { ...entry, requestedBy: [...entry.requestedBy] };
    }

    let pending = [holder];

    while (pending.length > 0) {
        const going = new Set(pending);
        pending = [];

        for (const [key, entry] of Object.entries(recipes)) {
            const kept = entry.requestedBy.filter((name) => !going.has(name));

            if (kept.length === entry.requestedBy.length) {
                continue;
            }

            if (kept.length === 0) {
                delete recipes[key];
                pending.push(key);
            } else {
                recipes[key] = withHolders(entry, kept);
            }
        }
    }

    return withReposOf(lock, recipes, label);
}

/** The label used when no lockfile path is known. */
const LOCKFILE_LABEL = "the lockfile";

/** Keeps only the repositories the recipes use, failing when one has no entry. */
function withReposOf(lock: Lockfile, recipes: Record<string, LockedRecipe>, label: string): Lockfile {
    const lockedRepos: Lockfile["repos"] = {};
    const orphaned: string[] = [];

    for (const name of usedRepos(recipes)) {
        const entry = lock.repos[name];

        if (entry === undefined) {
            orphaned.push(name);
            continue;
        }

        lockedRepos[name] = entry;
    }

    if (orphaned.length > 0) {
        throw new ConfigError(`The lockfile at ${label} pins recipes to repositories it does not describe: ${orphaned.join(", ")}.`, {
            details: [
                "Every repository a locked recipe came from needs an entry in the lockfile's 'repos' block.",
                "This usually means the file was edited by hand or merged badly. Run 'sous lock rebuild' to rebuild it from your config.",
            ],
        });
    }

    return { formatVersion: 1, repos: lockedRepos, recipes: sortRecipes(recipes) };
}

/** The repositories a set of recipes comes from, sorted. */
function usedRepos(recipes: Record<string, LockedRecipe>): string[] {
    return sortKeys(new Set(Object.values(recipes).map((entry) => entry.repo)));
}

/**
 * Every locked recipe reachable from some keys through the holder lists: the keys, whatever they
 * hold, and so on. Sorted.
 */
export function lockedClosure(lock: Lockfile, roots: Iterable<string>): string[] {
    const reached = new Set([...roots].filter((key) => Object.hasOwn(lock.recipes, key)));
    const queue = [...reached];

    while (queue.length > 0) {
        const holder = queue.shift() as string;

        for (const [key, entry] of Object.entries(lock.recipes)) {
            if (!reached.has(key) && entry.requestedBy.includes(holder)) {
                reached.add(key);
                queue.push(key);
            }
        }
    }

    return sortKeys(reached);
}

/**
 * The lockfile keys one subscription holds directly: a recipe key holds itself, a namespace every
 * recipe in it. Only entries the project itself holds count.
 *
 * @param key - The subscription's key: `namespace`, or `namespace/recipe`.
 */
export function keysHeldBySubscription(lock: Lockfile, key: string): string[] {
    const heldByProject = (entry: string): boolean => lock.recipes[entry]?.requestedBy.includes(PROJECT_HOLDER) === true;

    if (key.includes("/")) {
        return heldByProject(key) ? [key] : [];
    }

    return sortKeys(Object.keys(lock.recipes).filter((entry) => entry.startsWith(`${key}/`) && heldByProject(entry)));
}

/** Lock changes in order: by key, the shared version before any holder's own. */
function byKey(left: LockChange, right: LockChange): number {
    const one = `${left.key}\0${left.holder ?? ""}`;
    const other = `${right.key}\0${right.holder ?? ""}`;

    return one < other ? -1 : one > other ? 1 : 0;
}

/** What changed between two lockfiles. */
export function diffLockfiles(before: Lockfile, after: Lockfile): LockDiff {
    const added: LockChange[] = [];
    const removed: LockChange[] = [];
    const updated: LockChange[] = [];

    for (const [key, entry] of Object.entries(after.recipes)) {
        const previous = before.recipes[key];

        if (previous === undefined) {
            added.push({ key, to: entry.version });
        } else if (previous.version !== entry.version) {
            updated.push({ key, from: previous.version, to: entry.version });
        }

        // A version pinned for one holder changes on its own.
        for (const holder of sortKeys(new Set([...Object.keys(entry.pins ?? {}), ...Object.keys(previous?.pins ?? {})]))) {
            const from = previous?.pins?.[holder]?.version;
            const to = entry.pins?.[holder]?.version;

            if (from === to) {
                continue;
            }

            if (from === undefined) {
                added.push({ key, holder, to: to as string });
            } else if (to === undefined) {
                removed.push({ key, holder, from });
            } else {
                updated.push({ key, holder, from, to });
            }
        }
    }

    for (const [key, entry] of Object.entries(before.recipes)) {
        if (!Object.hasOwn(after.recipes, key)) {
            removed.push({ key, from: entry.version });

            for (const [holder, pin] of Object.entries(entry.pins ?? {})) {
                removed.push({ key, holder, from: pin.version });
            }
        }
    }

    const reposAdded = sortKeys(Object.keys(after.repos).filter((name) => !Object.hasOwn(before.repos, name)));
    const reposRemoved = sortKeys(Object.keys(before.repos).filter((name) => !Object.hasOwn(after.repos, name)));

    added.sort(byKey);
    removed.sort(byKey);
    updated.sort(byKey);

    return {
        added,
        removed,
        updated,
        reposAdded,
        reposRemoved,
        unchanged: added.length + removed.length + updated.length + reposAdded.length + reposRemoved.length === 0,
    };
}

/**
 * The diff as plain lines, one per change, in the words today's commands print.
 *
 * ```text
 * Repository added: acme
 * Adding workflow/task-files version 1.2.0
 * Updating core/sous-skills from version 0.2.33 to version 0.2.34
 * Adding workflow/shared version 1.0.0 for workflow/a alone
 * Removing tools/old, which nothing needs any more
 * ```
 */
export function describeLockDiff(diff: LockDiff): string[] {
    const lines: string[] = [];

    for (const name of diff.reposAdded) {
        lines.push(`Repository added: ${name}`);
    }

    const alone = (change: LockChange): string => (change.holder === undefined ? "" : ` for ${change.holder} alone`);

    for (const change of [...diff.added].sort(byKey)) {
        lines.push(`Adding ${change.key} version ${change.to}${alone(change)}`);
    }

    for (const change of [...diff.updated].sort(byKey)) {
        lines.push(`Updating ${change.key} from version ${change.from} to version ${change.to}${alone(change)}`);
    }

    for (const change of [...diff.removed].sort(byKey)) {
        lines.push(change.holder === undefined ? `Removing ${change.key}, which nothing needs any more` : `Removing the version ${change.from} of ${change.key} pinned for ${change.holder} alone`);
    }

    for (const name of diff.reposRemoved) {
        lines.push(`Repository no longer needed: ${name}`);
    }

    if (diff.unchanged) {
        lines.push("Nothing changed.");
    }

    return lines;
}
