import type { Context } from "@sous-io/plugin-api";
import type { LockDiff, RecipesLock, ResolvedRecipe, ResolveResult, RestoreReport, SubscriptionEntry } from "@sous-io/plugin-recipes/types";
import semver from "semver";
import type { BuildPrepareInput, BuildPrepareResult } from "./types.js";

/** The lockfile, as `recipes.lock` reads it. */
type Lockfile = ReturnType<RecipesLock["read"]>;

/** The holder a subscription's own pins are requested by. */
const PROJECT_HOLDER = "project";

/** A lock diff that changed nothing. */
export const NO_CHANGE: LockDiff = Object.freeze({
    added: [],
    removed: [],
    updated: [],
    reposAdded: [],
    reposRemoved: [],
    unchanged: true,
}) as LockDiff;

/** A restore that restored nothing. */
export const NOTHING_RESTORED: RestoreReport = Object.freeze({ restored: [], alreadyPresent: [], failed: [] }) as RestoreReport;

/**
 * `build.prepare` (internal): gets the project's recipes ready to compile (S6). In order:
 *
 * 1. seeding the core recipe: the `recipes.core` contributor does this while the config is built,
 *    so this only lists the core recipes that are active;
 * 2. locking every switched-on subscription the lockfile does not pin yet;
 * 3. restoring what the store is missing, at exactly the pinned versions;
 * 4. checking upstream: a recipe whose repository or subscription prefers newer versions
 *    (`alwaysPull`) moves to the newest version in range; every other newer version is only
 *    reported.
 *
 * A dry run writes nothing and never goes upstream. A failed upstream check is reported and then
 * ignored, because a build must not depend on the network being up. When the lockfile changed, the
 * config is marked changed, so the next chain sees the recipes it now pins.
 */
export async function prepare(input: BuildPrepareInput, ctx: Context): Promise<BuildPrepareResult> {
    const dryRun = input.dryRun === true;
    const lock = ctx.services.get("recipes.lock");
    const resolver = ctx.services.get("recipes.resolver");
    const active = ctx.services.get("recipes.active");
    const subscriptions = switchedOn(ctx.config.get("subscriptions") ?? {});

    const seeded = active
        .list()
        .filter((recipe) => recipe.source === "core")
        .map((recipe) => recipe.id);

    let current = lock.read();
    let locked: LockDiff = NO_CHANGE;

    // 2. Lock new subscriptions.
    const unlocked = Object.entries(subscriptions).filter(([key, entry]) => !isLocked(key, entry, current));

    if (unlocked.length > 0) {
        try {
            const resolved = await resolver.resolveSubscriptions({ keep: pinnedVersions(current) });

            warnAboutProblems(resolved, ctx);

            const next = lock.fromResolved(resolved.resolved, current);

            locked = await lock.write(next, { dryRun });
            current = next;
        } catch (error) {
            const keys = unlocked.map(([key]) => `'${key}'`).join(", ");

            ctx.reporter.warning(`Sous could not work out which version of ${keys} to use, so nothing from it was compiled.\n${describe(error)}`);
        }
    }

    // 3. Restore.
    let restored: RestoreReport = NOTHING_RESTORED;

    if (!dryRun && Object.keys(current.recipes).length > 0) {
        try {
            restored = await lock.restore();
        } catch (error) {
            ctx.reporter.warning(`Sous could not restore the recipes this project's lockfile pins.\n${describe(error)}`);
        }
    }

    // 4. Check upstream.
    let checkedUpstream = false;
    const newer: Array<{ key: string; from: string; to: string }> = [];

    if (!dryRun && input.offline !== true && Object.keys(current.recipes).length > 0) {
        const upstream = await checkUpstream(ctx, current, subscriptions);

        checkedUpstream = upstream.checked;
        newer.push(...upstream.newer);

        if (upstream.moved.length > 0) {
            const movedKeys = new Set(upstream.moved.map((change) => change.key));
            const keep = Object.fromEntries(Object.entries(pinnedVersions(current)).filter(([key]) => !movedKeys.has(key)));

            try {
                const resolved = await resolver.resolveSubscriptions({ keep });
                const next = lock.fromResolved(resolved.resolved, current);

                locked = mergeDiffs(locked, await lock.write(next));
                current = next;
                restored = mergeRestores(restored, await lock.restore({ keys: [...movedKeys] }));
            } catch (error) {
                ctx.reporter.warning(`Sous could not move to the newer recipe versions, so this build uses the versions it already had.\n${describe(error)}`);
            }
        }
    }

    if (!locked.unchanged && !dryRun) {
        ctx.configChanged();
    }

    const result: BuildPrepareResult = {
        seeded,
        locked,
        restored,
        newer,
        checkedUpstream,
        skipped: active.skipped(),
        unanswered: ctx.services.get("recipe-answers.answers").get().unanswered,
    };

    await ctx.emit("build.prepared", result);

    return result;
}

/** What looking upstream found. */
interface UpstreamReport {
    /** Whether any index was read from upstream. */
    checked: boolean;
    /** Newer versions of recipes that prefer them: these move. */
    moved: Array<{ key: string; from: string; to: string }>;
    /** Newer versions of every other recipe: only reported. */
    newer: Array<{ key: string; from: string; to: string }>;
}

/**
 * Refreshes the indexes the freshness window says are due, then resolves every subscription with
 * nothing held, so each recipe resolves to the newest version its ranges allow. A failed read is a
 * warning; the cached index answers instead.
 */
async function checkUpstream(ctx: Context, current: Lockfile, subscriptions: Record<string, SubscriptionEntry>): Promise<UpstreamReport> {
    const report: UpstreamReport = { checked: false, moved: [], newer: [] };
    let indexes;

    try {
        indexes = await ctx.services.get("recipes.index-cache").getAll();
    } catch (error) {
        ctx.reporter.warning(`Sous could not check upstream for newer recipe versions, so this build uses the versions it already had.\n${describe(error)}`);

        return report;
    }

    report.checked = indexes.indexes.some((index) => index.source === "network");

    for (const failure of indexes.failed) {
        const reasons = failure.attempts.map((attempt) => `${attempt.strategy}: ${attempt.reason}`).join("\n");

        ctx.reporter.warning(
            `Sous could not check the repository '${failure.repo}' for a newer version, so this build uses the versions it already had.` +
                (reasons ? `\n${reasons}` : ""),
        );
    }

    let latest: ResolveResult;

    try {
        latest = await ctx.services.get("recipes.resolver").resolveSubscriptions({ quiet: true });
    } catch (error) {
        ctx.reporter.warning(`Sous could not work out the newest recipe versions, so this build uses the versions it already had.\n${describe(error)}`);

        return report;
    }

    const repos = ctx.config.get("repos") ?? {};

    for (const recipe of latest.resolved) {
        const pinned = current.recipes[recipe.key];

        if (!pinned || !isNewer(recipe.version, pinned.version)) {
            continue;
        }

        const change = { key: recipe.key, from: pinned.version, to: recipe.version };

        if (prefersNewer(recipe, subscriptions, repos[recipe.repo]?.alwaysPull === true)) {
            report.moved.push(change);
        } else {
            report.newer.push(change);
        }
    }

    return report;
}

/** Whether a recipe's repository or subscription prefers a newer in-range version. */
function prefersNewer(recipe: ResolvedRecipe, subscriptions: Record<string, SubscriptionEntry>, repoPrefers: boolean): boolean {
    return repoPrefers || subscriptions[recipe.key]?.alwaysPull === true || subscriptions[recipe.namespace]?.alwaysPull === true;
}

function isNewer(candidate: string, pinned: string): boolean {
    const a = semver.valid(candidate);
    const b = semver.valid(pinned);

    return a !== null && b !== null && semver.gt(a, b);
}

/** The subscriptions switched on on this machine (S4, 3). */
export function switchedOn(subscriptions: Readonly<Record<string, SubscriptionEntry>>): Record<string, SubscriptionEntry> {
    return Object.fromEntries(Object.entries(subscriptions).filter(([, entry]) => entry.enabled !== false));
}

/**
 * Whether the lockfile already pins a subscription: a recipe key pins itself, a namespace pins
 * every locked recipe under it; each must be held by the project and satisfy the range.
 */
export function isLocked(key: string, entry: SubscriptionEntry, lockfile: Lockfile): boolean {
    const matches = key.includes("/")
        ? [lockfile.recipes[key]].filter((locked) => locked !== undefined)
        : Object.entries(lockfile.recipes)
              .filter(([lockedKey]) => lockedKey.startsWith(`${key}/`))
              .map(([, locked]) => locked);

    if (matches.length === 0) {
        return false;
    }

    const range = entry.range;
    const includePrerelease = entry.prerelease === true;

    return matches.every((locked) => {
        if (!locked.requestedBy.includes(PROJECT_HOLDER)) {
            return false;
        }

        if (range === undefined || range === "*") {
            return true;
        }

        return semver.satisfies(locked.version, range, { includePrerelease });
    });
}

/** Every pinned version, by key: what a resolve holds. */
function pinnedVersions(lockfile: Lockfile): Record<string, string> {
    return Object.fromEntries(Object.entries(lockfile.recipes).map(([key, locked]) => [key, locked.version]));
}

/** Reports what a resolve could not do: a repository to trust, a manifest it could not read, a cycle. */
function warnAboutProblems(resolved: ResolveResult, ctx: Context): void {
    for (const missing of resolved.missingRepos) {
        const by = missing.requiredBy.map((entry) => entry.ref).join(", ");

        ctx.reporter.warning(
            `Sous could not lock ${by || "a subscription"}: it needs the repository '${missing.name}', which this project does not trust yet, so nothing from it was compiled.\n` +
                `Run 'sous repo add ${missing.url ?? missing.name}' to trust it.`,
        );
    }

    for (const key of resolved.unreadable) {
        ctx.reporter.warning(`Sous could not read the manifest of '${key}', so nothing from it was compiled.`);
    }

    for (const cycle of resolved.cycles) {
        ctx.reporter.warning(`These recipes depend on each other in a cycle: ${cycle.join(" -> ")}.`);
    }
}

/** Two lock diffs as one. */
export function mergeDiffs(first: LockDiff, second: LockDiff): LockDiff {
    if (first.unchanged) {
        return second;
    }

    if (second.unchanged) {
        return first;
    }

    return {
        added: [...first.added, ...second.added],
        removed: [...first.removed, ...second.removed],
        updated: [...first.updated, ...second.updated],
        reposAdded: [...new Set([...first.reposAdded, ...second.reposAdded])],
        reposRemoved: [...new Set([...first.reposRemoved, ...second.reposRemoved])],
        unchanged: false,
    };
}

function mergeRestores(first: RestoreReport, second: RestoreReport): RestoreReport {
    return {
        restored: [...new Set([...first.restored, ...second.restored])],
        alreadyPresent: [...new Set([...first.alreadyPresent, ...second.alreadyPresent])],
        failed: [...first.failed, ...second.failed],
    };
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
