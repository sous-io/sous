/**
 * Subscription bookkeeping shared by the subscription and repository intents (ported from
 * `src/lib/repos/subscription-service.ts`): which key a typed ref names, and what removing one
 * subscription does to the lockfile, refcounted.
 */

import { SousError, type Context } from "@sous-io/plugin-api";
import type { Lockfile } from "@sous-io/plugin-formats/types";
import type { NamedRef } from "@sous-io/plugin-refs/types";
import type { SubscriptionEntry } from "../types.js";
import { findInCatalog } from "./catalog.js";
import { loadCatalog, pickMatch, readingsOf } from "./catalog-context.js";
import { isBuiltInEntry } from "./defaults.js";
import { dropProjectHold, keysHeldBySubscription, stayedAfter } from "./lock-holds.js";
import { configuredSubscriptions, deleteSubscriptionEntry, managedEntries, SUBSCRIPTIONS_LAYER, writeSubscriptionEntry } from "./project.js";
import { sortBytewise } from "./util.js";

/** Whether a reading names a namespace or recipe with no location. */
export function isShortNamed(ref: { kind: string }): ref is NamedRef {
    if (ref.kind !== "namespace" && ref.kind !== "recipe") {
        return false;
    }

    const named = ref as NamedRef;
    const repo = named.kind === "namespace" ? named.repo : (named.namespace?.repo ?? named.repo);

    return repo?.location === undefined;
}

/**
 * The subscription key a typed ref names, among the keys in force: exactly first, then ignoring
 * case. A location is settled through the trusted repository at that location.
 */
export async function subscriptionKeyFor(ctx: Context, written: string, keys: readonly string[]): Promise<string> {
    const readings = readingsOf(ctx, written);
    const short = readings.find(isShortNamed);

    if (short !== undefined) {
        const key = ctx.services.get("refs.format").key(short);

        return keys.find((candidate) => candidate === key) ?? keys.find((candidate) => candidate.toLowerCase() === key.toLowerCase()) ?? key;
    }

    const catalog = await loadCatalog(ctx);
    const match = await pickMatch(ctx, findInCatalog(catalog.inputs, readings, ["namespace", "recipe"]), written.trim(), undefined, () =>
        new SousError(`'${written.trim()}' names no namespace or recipe this project knows.`),
    );

    return match.key;
}

/** What removing one subscription does, worked out before anything is written. */
export interface SubscriptionRemoval {
    readonly key: string;
    /** True for a subscription sous provides itself: it is switched off instead of removed. */
    readonly optedOut: boolean;
    readonly after: Lockfile;
    readonly stayed: Array<{ key: string; heldBy: string[] }>;
}

/**
 * Plans removing one subscription. A subscription sous wrote can be removed; one sous provides
 * itself is switched off; one written in the project's own files is not sous's to edit, so that is
 * an error naming the file and `subscription disable`, which switches it off from the managed file.
 */
export async function planSubscriptionRemoval(ctx: Context, key: string, lock: Lockfile): Promise<SubscriptionRemoval> {
    const configured = configuredSubscriptions(ctx.config);
    const managed = await managedEntries<SubscriptionEntry>(ctx.services.get("confd.managed"), SUBSCRIPTIONS_LAYER, "subscriptions");
    const held = keysHeldBySubscription(lock, key);
    const removable = Object.hasOwn(managed, key) && managed[key]?.enabled !== false;
    const builtIn = !removable && isBuiltInEntry(configured[key]);

    if (!removable && !builtIn) {
        if (!Object.hasOwn(configured, key) && held.length === 0) {
            const known = sortBytewise(Object.keys(configured).filter((entry) => configured[entry]?.enabled !== false));

            throw new SousError(`This project does not subscribe to '${key}'.`, {
                details: [known.length > 0 ? `It subscribes to: ${known.join(", ")}.` : "It has no subscriptions yet."],
            });
        }

        if (Object.hasOwn(configured, key)) {
            throw new SousError(`The subscription to '${key}' is written in one of this project's own config files, not in the file sous manages.`, {
                details: [
                    "Remove its entry from the 'subscriptions' block of that file; sous never deletes what you wrote.",
                    `To switch it off on this machine instead, run 'sous subscription disable ${key}'.`,
                ],
            });
        }
    }

    let after = lock;

    for (const heldKey of held) {
        after = dropProjectHold(after, heldKey);
    }

    return { key, optedOut: builtIn, after, stayed: stayedAfter(after, held) };
}

/** Writes a planned removal to `conf.d/510`: deletes the entry, or records `enabled: false` for a built-in one. */
export async function writeSubscriptionRemoval(ctx: Context, removal: SubscriptionRemoval): Promise<void> {
    const managed = ctx.services.get("confd.managed");

    if (removal.optedOut) {
        await writeSubscriptionEntry(managed, removal.key, { enabled: false });
    } else {
        await deleteSubscriptionEntry(managed, removal.key);
    }
}
