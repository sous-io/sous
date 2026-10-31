/**
 * Which locked recipes are in force on this machine: only those reached from the
 * subscriptions switched on here, through repositories trusted and switched on here. Every other
 * locked recipe keeps its pin and is skipped, with one sentence saying why.
 */

import type { Lockfile } from "@sous-io/plugin-formats/types";
import type { RepoEntry, SkippedRecipe, SubscriptionEntry } from "../../types.js";
import { PROJECT_HOLDER } from "../constants.js";
import { sortKeys } from "../support.js";
import { keysHeldBySubscription } from "./lockfile-ops.js";

/** What deciding reachability reads. */
export interface ReachabilityInput {
    readonly lockfile: Lockfile;
    /** Every subscription in the config, switched on or off. */
    readonly subscriptions: Readonly<Record<string, SubscriptionEntry>> | undefined;
    /** Every repository in the config, switched on or off. */
    readonly repos: Readonly<Record<string, RepoEntry>> | undefined;
    /** The stored key a subscription key names: `namespace` or `namespace/recipe`. */
    readonly keyOf?: (subscriptionKey: string) => string;
    /** The file that switched a subscription off, when known (`conf.d/610-mac.jsonc`). */
    readonly setBy?: (subscriptionKey: string) => string | undefined;
}

/** What is in force, and what is skipped. */
export interface Reachability {
    /** Locked keys in force here, sorted. */
    readonly reached: string[];
    /** Locked keys that are not, with why. */
    readonly skipped: SkippedRecipe[];
}

/**
 * The stored key a subscription key names, without a repository qualifier or a range.
 *
 * ```ts
 * plainSubscriptionKey("acme:workflow/task-files@^1"); // "workflow/task-files"
 * ```
 */
export function plainSubscriptionKey(key: string): string {
    const colon = key.indexOf(":");
    const unqualified = colon === -1 || key.includes("://") ? key : key.slice(colon + 1);
    const at = unqualified.indexOf("@");

    return (at === -1 ? unqualified : unqualified.slice(0, at)).replace(/\/\*$/, "");
}

/** Works out what is in force and what is skipped. */
export function reachability(input: ReachabilityInput): Reachability {
    const { lockfile } = input;
    const keyOf = input.keyOf ?? plainSubscriptionKey;
    const repos = input.repos ?? {};
    const usable = (key: string): boolean => {
        const repo = repos[lockfile.recipes[key].repo];

        return repo !== undefined && repo.enabled !== false;
    };

    const on: string[] = [];
    const off: Array<{ subscription: string; key: string }> = [];

    for (const [subscription, entry] of Object.entries(input.subscriptions ?? {})) {
        const key = safeKey(keyOf, subscription);

        if (key === undefined) {
            continue;
        }

        if (entry?.enabled === false) {
            off.push({ subscription, key });
        } else {
            on.push(key);
        }
    }

    const reached = new Set<string>();
    const queue: string[] = [];

    // The narrower entry wins: a recipe subscription switched off stays off inside a namespace
    // subscription that is on (it is still reached when another active recipe needs it).
    const offRecipes = new Set(off.filter((entry) => entry.key.includes("/")).map((entry) => entry.key));

    for (const key of on.flatMap((subscription) => keysHeldBySubscription(lockfile, subscription))) {
        if (!reached.has(key) && usable(key) && !(offRecipes.has(key) && !on.includes(key))) {
            reached.add(key);
            queue.push(key);
        }
    }

    while (queue.length > 0) {
        const holder = queue.shift() as string;

        for (const [key, entry] of Object.entries(lockfile.recipes)) {
            if (!reached.has(key) && entry.requestedBy.includes(holder) && usable(key)) {
                reached.add(key);
                queue.push(key);
            }
        }
    }

    const skipped: SkippedRecipe[] = [];

    for (const key of sortKeys(Object.keys(lockfile.recipes))) {
        if (!reached.has(key)) {
            skipped.push(whySkipped(key, lockfile, repos, off, input.setBy));
        }
    }

    return { reached: sortKeys(reached), skipped };
}

/** One skipped recipe's reason. */
function whySkipped(
    key: string,
    lockfile: Lockfile,
    repos: Readonly<Record<string, RepoEntry>>,
    off: ReadonlyArray<{ subscription: string; key: string }>,
    setBy: ((subscription: string) => string | undefined) | undefined,
): SkippedRecipe {
    const repoName = lockfile.recipes[key].repo;
    const repo = repos[repoName];

    if (repo === undefined) {
        return {
            key,
            reason: "untrusted",
            message: `Skipped ${key}: its repository '${repoName}' is not trusted in this project.`,
        };
    }

    if (repo.enabled === false) {
        return {
            key,
            reason: "repository-disabled",
            message: `Skipped ${key}: its repository '${repoName}' is switched off.`,
        };
    }

    const heldByProject = lockfile.recipes[key].requestedBy.includes(PROJECT_HOLDER);
    const switchedOff = off.find((entry) => entry.key === key || (!entry.key.includes("/") && key.startsWith(`${entry.key}/`)));

    if (switchedOff && heldByProject) {
        const file = setBy?.(switchedOff.subscription);

        return {
            key,
            reason: "subscription-disabled",
            subscription: switchedOff.subscription,
            ...(file === undefined ? {} : { setBy: file }),
            message: `Skipped ${key}: its subscription is switched off${file === undefined ? "" : ` (${file})`}.`,
        };
    }

    return {
        key,
        reason: "not-reached",
        message: `Skipped ${key}: no subscription switched on here reaches it.`,
    };
}

/** A subscription's key, or `undefined` when it does not parse. */
function safeKey(keyOf: (key: string) => string, subscription: string): string | undefined {
    try {
        return keyOf(subscription);
    } catch {
        return undefined;
    }
}
