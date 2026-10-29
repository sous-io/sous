/**
 * Why a recipe a project template includes is not active, when that can be known without the
 * network: a subscription to it (or its namespace) that is switched off, or another published
 * version of a pinned recipe that brought it in. Runs only while an error is being reported.
 */

import semver from "semver";
import type { DroppedRecipe } from "@sous-io/plugin-compiler/types";
import type { IndexFile, Lockfile } from "@sous-io/plugin-formats/types";
import type { SubscriptionEntry } from "../../types.js";
import { sortKeys } from "../support.js";

/** What explaining reads. */
export interface ExplainInput {
    readonly subscriptions: Readonly<Record<string, SubscriptionEntry>> | undefined;
    /** The stored key a subscription key names. */
    readonly keyOf: (subscription: string) => string;
    readonly lockfile: () => Lockfile;
    /** The cached index of a repository, by identity. */
    readonly cachedIndex: (identity: string) => IndexFile | undefined;
}

/** Why a recipe is not active, or `undefined`. */
export function explainMissing(recipe: string, input: ExplainInput): DroppedRecipe | undefined {
    const namespace = recipe.slice(0, recipe.indexOf("/"));

    for (const [key, entry] of Object.entries(input.subscriptions ?? {})) {
        if (entry?.enabled !== false) {
            continue;
        }

        let stored: string;

        try {
            stored = input.keyOf(key);
        } catch {
            continue;
        }

        if (stored === recipe || stored === namespace) {
            return { by: "disabled-subscription", subscription: key };
        }
    }

    let lock: Lockfile;

    try {
        lock = input.lockfile();
    } catch {
        return undefined;
    }

    const published = new Map<string, IndexFile["recipes"][string]["versions"]>();

    for (const identity of sortKeys(new Set(Object.values(lock.repos).flatMap((repo) => (repo.identity === undefined ? [] : [repo.identity]))))) {
        for (const [key, entry] of Object.entries(input.cachedIndex(identity)?.recipes ?? {})) {
            if (!published.has(key)) {
                published.set(key, entry.versions);
            }
        }
    }

    const declaredBy = (key: string, version: string): string[] => Object.keys(published.get(key)?.[version]?.dependencies ?? {});

    type Step = { key: string; root: { recipe: string; version: string }; through: string[] };
    const queue: Step[] = [];

    for (const holder of sortKeys(Object.keys(lock.recipes))) {
        const pinned = lock.recipes[holder].version;
        const versions = Object.keys(published.get(holder) ?? {})
            .filter((version) => version !== pinned && semver.valid(version) !== null)
            .sort(semver.rcompare);

        for (const version of versions) {
            for (const key of declaredBy(holder, version)) {
                queue.push({ key, root: { recipe: holder, version }, through: [] });
            }
        }
    }

    const seen = new Set<string>();

    while (queue.length > 0) {
        const step = queue.shift() as Step;

        if (step.key === recipe) {
            return {
                by: "recipe",
                recipe: step.root.recipe,
                declaredAt: step.root.version,
                pinned: lock.recipes[step.root.recipe].version,
                ...(step.through.length > 0 ? { through: step.through } : {}),
            };
        }

        if (Object.hasOwn(lock.recipes, step.key) || seen.has(step.key)) {
            continue;
        }

        seen.add(step.key);

        for (const version of Object.keys(published.get(step.key) ?? {})) {
            for (const key of declaredBy(step.key, version)) {
                queue.push({ key, root: step.root, through: [...step.through, step.key] });
            }
        }
    }

    return undefined;
}
