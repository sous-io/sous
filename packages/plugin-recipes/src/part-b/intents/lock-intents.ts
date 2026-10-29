/**
 * `lock.rebuild`, `lock.show` and `repo.gc`: the intents over the lockfile and the store.
 */

import { ConfigError, type Context } from "@sous-io/plugin-api";
import type {
    LockRebuildInput,
    LockRebuildResult,
    LockShowResult,
    RepoEntry,
    RepoGcInput,
    StoreGcReport,
    StoreKey,
    StoreSettings,
    SubscriptionEntry,
} from "../../types.js";
import { describeLockDiff } from "../lock/lockfile-ops.js";
import { trustedRepos } from "../lock/lock-service.js";
import { reachability } from "../lock/reachable.js";
import { storeKeyOf } from "../fetch/restore.js";
import type { ResolverService } from "../resolver/resolver-service.js";
import { plural } from "../support.js";

/**
 * Resolves every subscription again against the cached indexes and rewrites the lockfile, keeping
 * the pins of switched-off subscriptions (S4, 2), then downloads what the store lacks.
 */
export async function rebuildLock(input: LockRebuildInput, ctx: Context): Promise<LockRebuildResult> {
    const lock = ctx.services.get("recipes.lock");
    const resolver = ctx.services.get("recipes.resolver");
    const result = await resolver.resolveSubscriptions();

    if (result.missingRepos.length > 0) {
        throw new ConfigError(`This project's subscriptions need ${result.missingRepos.length === 1 ? "a repository" : "repositories"} it does not trust, so the lockfile cannot be rebuilt.`, {
            details: [
                ...result.missingRepos.map((missing) => `${missing.name}${missing.url === undefined ? "" : ` (${missing.url})`}, needed by ${missing.requiredBy.map((entry) => entry.ref).join(", ")}`),
                `Add ${result.missingRepos.length === 1 ? "it" : "them"} with 'sous repo add <url>', which is how a repository is trusted, then run this command again.`,
            ],
        });
    }

    const before = lock.read();
    const after = lock.fromResolved(result.resolved, before);
    const diff = lock.diff(before, after);

    for (const line of describeLockDiff(diff)) {
        ctx.reporter.note(line);
    }

    const cache = ctx.services.get("recipes.index-cache");
    const notFetched = Object.keys(trustedRepos(ctx)).filter((name) => {
        try {
            return cache.cached(name) === undefined;
        } catch {
            return true;
        }
    });

    if (notFetched.length > 0) {
        ctx.reporter.note(`These repositories are trusted and their index has not been fetched yet, so nothing in them could be resolved: ${notFetched.sort().join(", ")}.`);
    }

    if (result.unreadable.length > 0) {
        ctx.reporter.note(
            `The files of these recipes are not on this machine, and their repository's index does not record what they depend on, so their own dependencies are not in the rebuilt lockfile: ${result.unreadable.join(", ")}.`,
        );
    }

    for (const cycle of result.cycles) {
        ctx.reporter.note(`These recipes depend on each other in a circle: ${cycle.join(" -> ")}.`);
    }

    if (input.dryRun) {
        ctx.reporter.note(`Dry run: nothing was written. The lockfile is ${lock.path()}.`);

        return { diff, lockfile: after, missingRepos: result.missingRepos, restored: { restored: [], alreadyPresent: [], failed: [] }, dryRun: true };
    }

    await lock.write(after);
    ctx.configChanged();

    const subscriptions = Object.keys(ctx.config.get<Record<string, SubscriptionEntry>>("subscriptions") ?? {}).length;

    ctx.reporter.note(`The lockfile was rebuilt from ${plural(subscriptions, "subscription")} and now pins ${plural(Object.keys(after.recipes).length, "recipe")}: ${lock.path()}.`);

    const restored = await lock.restore({ keys: resolver.reachable(after) });

    for (const failure of restored.failed) {
        ctx.reporter.warning(`Sous could not download ${failure.key}: ${failure.reason}`);
    }

    return { diff, lockfile: after, missingRepos: result.missingRepos, restored, dryRun: false };
}

/** Every recipe the lockfile pins, with whether it is active here and, when not, why. */
export function showLock(ctx: Context): LockShowResult {
    const lock = ctx.services.get("recipes.lock");
    const lockfile = lock.read();
    const { skipped } = reachability({
        lockfile,
        subscriptions: ctx.config.get<Record<string, SubscriptionEntry>>("subscriptions"),
        repos: ctx.config.get<Record<string, RepoEntry>>("repos"),
        keyOf: (key) => (ctx.services.get("recipes.resolver") as ResolverService).keyOf(key),
    });
    const why = new Map(skipped.map((entry) => [entry.key, entry]));

    return {
        path: lock.path(),
        lockfile,
        recipes: Object.keys(lockfile.recipes)
            .sort()
            .map((key) => {
                const reason = why.get(key);
                const active = ctx.entities.has("active-recipe", key) || (reason === undefined && !ctx.entities.kinds().includes("active-recipe"));

                return { key, entry: lockfile.recipes[key], active, ...(reason === undefined ? {} : { skipped: reason }) };
            }),
    };
}

/** Collects the store back down to its size cap, never evicting what this project pins. */
export async function collectStore(input: RepoGcInput, ctx: Context): Promise<StoreGcReport> {
    const lockfile = ctx.services.get("recipes.lock").read();
    const keep: StoreKey[] = [];

    for (const [key, entry] of Object.entries(lockfile.recipes)) {
        const identity = lockfile.repos[entry.repo]?.identity;

        if (identity !== undefined) {
            keep.push(storeKeyOf(key, identity, entry.version));
        }
    }

    const maxBytes = input.maxBytes ?? ctx.config.get<Partial<StoreSettings>>("store")?.maxBytes;
    const report = await ctx.services.get("recipes.store").gc({ keep, ...(maxBytes === undefined ? {} : { maxBytes }), ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }) });

    ctx.reporter.note(
        report.evicted.length === 0
            ? "The store is already inside its size cap, so nothing was removed."
            : report.dryRun
              ? `Nothing was removed. ${plural(report.evicted.length, "entry", "entries")} would be evicted; each is re-fetchable from the lockfile that pins it.`
              : `Evicted ${plural(report.evicted.length, "entry", "entries")}; the next build that needs one downloads it again.`,
    );

    return report;
}
