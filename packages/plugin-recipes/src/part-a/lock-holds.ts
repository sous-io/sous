/**
 * Refcounting over the lockfile's holder lists (ported from `src/lib/repos/locked-recipes.ts`,
 * `lock-service.ts` and `subscription-service.ts`). Pure: each function takes a lockfile and returns
 * a new one. Reading and writing the file is `recipes.lock`'s.
 *
 * Every pinned recipe lists who holds it in `requestedBy`: `project` for a subscription of the
 * project, or the key of a recipe depending on it. A recipe leaves the lockfile only when nothing
 * holds it any more.
 */

import type { LockedRecipe, Lockfile } from "@sous-io/plugin-formats/types";
import { PROJECT_HOLDER } from "../part-b/constants.js";
import { removeHolder } from "../part-b/lock/lockfile-ops.js";
import type { ResolvedRecipe } from "../types.js";
import { compareBytewise } from "./util.js";

export { PROJECT_HOLDER } from "../part-b/constants.js";
export { applyResolution, emptyLockfile, keysHeldBySubscription, lockedClosure, removeHolder, type LockRepoInput } from "../part-b/lock/lockfile-ops.js";

/** Drops the project's own hold on one recipe; the entry goes, refcounted, when nothing else holds it. */
export function dropProjectHold(lock: Lockfile, key: string): Lockfile {
    const entry = lock.recipes[key];

    if (entry === undefined) {
        return lock;
    }

    const kept = entry.requestedBy.filter((holder) => holder !== PROJECT_HOLDER);
    const recipes = { ...lock.recipes };

    if (kept.length > 0) {
        recipes[key] = { ...entry, requestedBy: kept };

        return { ...lock, recipes };
    }

    delete recipes[key];

    return removeHolder({ ...lock, recipes }, key);
}

/**
 * Combines two resolutions of the same recipe version, so every holder is kept.
 */
export function mergeHolders(left: ResolvedRecipe, right: ResolvedRecipe): ResolvedRecipe {
    const requestedBy = [...new Set([...left.requestedBy, ...right.requestedBy])].sort(compareBytewise);
    const ranges = [...left.ranges];

    for (const entry of right.ranges) {
        if (!ranges.some((seen) => seen.range === entry.range && seen.requestedBy === entry.requestedBy)) {
            ranges.push(entry);
        }
    }

    return {
        ...left,
        requestedBy,
        ranges,
        kind: left.kind === "subscribes" || right.kind === "subscribes" ? "subscribes" : "depends",
    };
}

/** Whether a stored key falls under a subscription's cover (`workflow` covers `workflow/a`). */
export function covers(cover: string | undefined, key: string): boolean {
    return cover !== undefined && (key === cover || key.startsWith(`${cover}/`));
}

/**
 * Releases every hold a new resolution no longer declares (an update): a holder that was resolved
 * again and did not ask for the recipe this time lets go of it, refcounted.
 *
 * @param resolvedCovers - The keys of the subscriptions resolved again.
 * @param otherCovers - The keys of the subscriptions left alone, whose holds stand.
 */
export function releaseDroppedHolds(
    lock: Lockfile,
    merged: ReadonlyMap<string, ResolvedRecipe>,
    resolvedCovers: readonly string[],
    otherCovers: readonly string[],
): Lockfile {
    const recipes: Record<string, LockedRecipe> = { ...lock.recipes };
    const orphaned: string[] = [];

    for (const [key, entry] of Object.entries(lock.recipes)) {
        const settled = merged.get(key);
        const kept = entry.requestedBy.filter((holder) => {
            if (holder === PROJECT_HOLDER) {
                if (!resolvedCovers.some((cover) => covers(cover, key))) {
                    return true;
                }

                if (otherCovers.some((cover) => covers(cover, key))) {
                    return true;
                }

                return settled?.requestedBy.includes(PROJECT_HOLDER) === true;
            }

            return !merged.has(holder) || settled?.requestedBy.includes(holder) === true;
        });

        if (kept.length === entry.requestedBy.length) {
            continue;
        }

        if (kept.length === 0) {
            delete recipes[key];
            orphaned.push(key);
        } else {
            recipes[key] = { ...entry, requestedBy: kept };
        }
    }

    let result: Lockfile = { ...lock, recipes };

    for (const key of orphaned) {
        result = removeHolder(result, key);
    }

    return result;
}

/** The recipes that stayed after a release, with who still holds each. */
export function stayedAfter(after: Lockfile, held: Iterable<string>): Array<{ key: string; heldBy: string[] }> {
    return [...new Set(held)]
        .filter((key) => Object.hasOwn(after.recipes, key))
        .sort(compareBytewise)
        .map((key) => ({ key, heldBy: [...after.recipes[key]!.requestedBy] }));
}
