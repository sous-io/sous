/**
 * `lock.rebuild`, `lock.show` and `repo.gc`: the intents over the lockfile and the store.
 */

import { ConfigError, IntentOutputs, LogLevel, type Context, type TableColumn } from "@sous-io/plugin-api";
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
import { blockOutput, describeSize, dryRunOutput, finish, sentence, tableOutput, underHeading } from "../../part-a/outputs.js";
import { plural } from "../support.js";

/**
 * Resolves every subscription again against the cached indexes and rewrites the lockfile, keeping
 * the pins of switched-off subscriptions, then downloads what the store lacks.
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

    ctx.reporter.list(describeLockDiff(diff), {}, LogLevel.Notice);

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
        ctx.reporter.dryRun(`Nothing was written. The lockfile is ${lock.path()}.`);

        return { diff, lockfile: after, missingRepos: result.missingRepos, restored: { restored: [], alreadyPresent: [], failed: [] }, dryRun: true };
    }

    await lock.write(after);
    ctx.configChanged();

    const subscriptions = Object.keys(ctx.config.get<Record<string, SubscriptionEntry>>("subscriptions") ?? {}).length;

    ctx.reporter.notice(`The lockfile was rebuilt from ${plural(subscriptions, "subscription")} and now pins ${plural(Object.keys(after.recipes).length, "recipe")}: ${lock.path()}.`);

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

    ctx.reporter.notice(
        report.evicted.length === 0
            ? "The store is already inside its size cap, so nothing was removed."
            : report.dryRun
              ? `Nothing was removed. ${plural(report.evicted.length, "entry", "entries")} would be evicted; each is re-fetchable from the lockfile that pins it.`
              : `Evicted ${plural(report.evicted.length, "entry", "entries")}; the next build that needs one downloads it again.`,
    );

    return report;
}

// --- The outputs ------------------------------------------------------------------------------------

/**
 * The outputs of `lock.rebuild`. The intent reports every change, every note and its closing
 * sentence as it goes, so the outputs hold only the result for machines.
 */
export function lockRebuildOutputs(result: LockRebuildResult): IntentOutputs<LockRebuildResult> {
    return IntentOutputs.of(result);
}

/** The recipe and its version stay at any width; the holders take what is left and wrap. */
const LOCK_COLUMNS: TableColumn[] = [
    { key: "key", header: "Recipe", kind: "path", overflow: "truncate", minWidth: 12 },
    { key: "version", header: "Version", overflow: "truncate", minWidth: 7 },
    { key: "repo", header: "Repository", overflow: "truncate", priority: "medium" },
    { key: "heldBy", header: "Held by", overflow: "wrap", flex: 1, priority: "low", minWidth: 16 },
];

function describeHolder(holder: string): string {
    return holder === "project" ? "this project" : holder;
}

/** The outputs of `lock.show`. */
export function lockShowOutputs(result: LockShowResult): IntentOutputs<LockShowResult> {
    const recipes = [...result.recipes].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
    const rows = recipes.map((recipe) => ({
        key: recipe.key,
        version: recipe.entry.version,
        repo: recipe.entry.repo,
        heldBy: recipe.entry.requestedBy.map(describeHolder).join(", "),
    }));
    const rowNotes = recipes.map((recipe) => (recipe.active ? undefined : `not built here: ${recipe.skipped?.message ?? "Not built on this machine."}`));
    const outputs = [
        tableOutput(LOCK_COLUMNS, rows, {
            heading: "Recipe versions this project pins",
            empty: `This project pins nothing yet. Its lockfile is ${result.path}.`,
            rowNotes,
        }),
    ];

    if (rows.length > 0) {
        outputs.push(sentence(`This project's lockfile is ${result.path}.`));
    }

    return finish(outputs, result);
}

const EVICTED_COLUMNS: TableColumn[] = [
    { key: "recipe", header: "Recipe", kind: "path", overflow: "truncate", minWidth: 12 },
    { key: "version", header: "Version", overflow: "truncate" },
    { key: "size", header: "Size", kind: "number" },
    { key: "repo", header: "Repository", overflow: "truncate", priority: "medium" },
    { key: "lastUsed", header: "Last used", priority: "low", flex: 1 },
];

/** The outputs of `repo.gc`. */
export function storeGcOutputs(report: StoreGcReport): IntentOutputs<StoreGcReport> {
    const outputs = [];

    if (report.dryRun) {
        outputs.push(dryRunOutput("Nothing will be removed."));
    }

    outputs.push(
        blockOutput({
            "Entries before": String(report.evicted.length + report.kept.length),
            "Entries kept": String(report.kept.length),
            "Entries evicted": String(report.evicted.length),
            "Size before": describeSize(report.bytesBefore),
            "Size after": describeSize(report.bytesAfter),
        }),
    );

    if (report.evicted.length > 0) {
        outputs.push(
            tableOutput(
                EVICTED_COLUMNS,
                report.evicted.map((entry) => ({
                    repo: entry.repo,
                    recipe: `${entry.namespace}/${entry.name}`,
                    version: entry.version,
                    size: describeSize(entry.sizeBytes),
                    lastUsed: entry.lastAccessAt,
                })),
            ),
        );
    }

    outputs.push(
        sentence(
            report.evicted.length === 0
                ? "The store is already inside its size cap, so nothing was removed."
                : report.dryRun
                  ? "Nothing was removed. Everything listed above is re-fetchable from the lockfile that pins it."
                  : "Everything removed is re-fetchable from the lockfile that pins it; the next build that needs one will download it again.",
        ),
    );

    return finish(underHeading("Collecting the recipe store", outputs), report);
}
