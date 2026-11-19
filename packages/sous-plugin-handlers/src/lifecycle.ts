/**
 * When `migrate`, `uninstall` and (on subscribing) `check` handlers run.
 *
 * - `migrate`: every write of the lockfile fires `recipes.locked` with what changed. A pin that
 *   moved (`sous subscription update`, a subscription that always pulls, subscribing again at
 *   another version) is remembered, and once a config is built in which the recipe is active at
 *   its new version (its files are in place), its `migrate` handlers run once, given
 *   `{ from, to }`. The pins are read from the lockfile; nothing else is stored.
 * - `uninstall`: during `sous subscription remove`, once the lockfile no longer pins a recipe and
 *   before the config is rebuilt without it, its `uninstall` handlers run. Its files are still in
 *   the store, its outputs are still in the project, and its handlers are still in the config.
 * - `check` on subscribing: the build `sous subscription add` runs checks every recipe; with
 *   `--no-build` there is no build, so the new recipes' checks run on their own.
 *
 * All the state is kept per engine, in the closure `registerLifecycle` makes.
 */

import type { Context, Sous } from "@sous-io/sous-plugin-api";
import type {} from "@sous-io/sous-plugin-recipes/types";
import type { LockChange } from "@sous-io/sous-plugin-recipes/types";

/** A version change waiting for the new version's files. */
interface PendingMigration {
    readonly from: string;
    readonly to: string;
}

/** Adds one lockfile write's moved pins to the waiting migrations. */
export function recordMoves(pending: Map<string, PendingMigration>, updated: readonly LockChange[]): void {
    for (const change of updated) {
        // A version pinned for one holder alone is that holder's library; the project never sees it.
        if (change.holder !== undefined || change.from === undefined || change.to === undefined || change.from === change.to) {
            continue;
        }

        const from = pending.get(change.key)?.from ?? change.from;

        if (from === change.to) {
            pending.delete(change.key);
        } else {
            pending.set(change.key, { from, to: change.to });
        }
    }
}

/** Registers the listeners. */
export function registerLifecycle(sous: Sous): void {
    const pending = new Map<string, PendingMigration>();
    /** Chains running `subscription.remove`, and the recipes whose uninstall handlers already ran in each. */
    const removing = new Map<number, Set<string>>();
    /** Chains running `subscription.add --no-build`, and the recipes the lockfile gained or moved in each. */
    const subscribing = new Map<number, Set<string>>();

    sous.on("recipes.locked", async (event, ctx) => {
        const { diff } = event.payload;

        recordMoves(pending, diff.updated);

        const chain = ctx.chain?.id;

        if (chain === undefined) {
            return;
        }

        for (const change of [...diff.added, ...diff.updated]) {
            if (change.holder === undefined) {
                subscribing.get(chain)?.add(change.key);
            }
        }

        const done = removing.get(chain);

        if (done !== undefined) {
            const keys = diff.removed.filter((change) => change.holder === undefined && !done.has(change.key)).map((change) => change.key);

            if (keys.length > 0) {
                keys.forEach((key) => done.add(key));
                await ctx.run("handlers.uninstall", { recipes: keys });
            }
        }
    });

    sous.on("config.built", async (_event, ctx) => {
        if (pending.size === 0) {
            return;
        }

        await runPendingMigrations(pending, ctx);
    });

    sous.on("subscription.remove.before", (event, ctx) => {
        if (event.input.dryRun !== true && ctx.chain !== undefined) {
            removing.set(ctx.chain.id, new Set());
        }
    });

    sous.on(/^subscription\.remove\.(after|error)$/, (_event, ctx) => {
        if (ctx.chain !== undefined) {
            removing.delete(ctx.chain.id);
        }
    });

    sous.on("subscription.add.before", (event, ctx) => {
        if (event.input.dryRun !== true && event.input.noBuild === true && ctx.chain !== undefined) {
            subscribing.set(ctx.chain.id, new Set());
        }
    });

    sous.on("subscription.add.error", (_event, ctx) => {
        if (ctx.chain !== undefined) {
            subscribing.delete(ctx.chain.id);
        }
    });

    sous.on("subscription.add.after", async (_event, ctx) => {
        const chain = ctx.chain?.id;
        const keys = chain === undefined ? undefined : subscribing.get(chain);

        if (chain === undefined || keys === undefined) {
            return;
        }

        subscribing.delete(chain);

        if (keys.size > 0) {
            await ctx.run("handlers.check", { recipes: [...keys] });
        }
    });
}

/**
 * Runs the `migrate` handlers of every waiting recipe that is now active at its new version, in
 * the lockfile's order, and forgets it. A recipe not active yet (its files not fetched) waits.
 */
export async function runPendingMigrations(pending: Map<string, PendingMigration>, ctx: Pick<Context, "entities" | "run">): Promise<void> {
    const active = ctx.entities.kinds().includes("active-recipe") ? ctx.entities.list("active-recipe") : [];

    for (const recipe of active) {
        const waiting = pending.get(recipe.id);

        if (waiting === undefined || recipe.version !== waiting.to) {
            continue;
        }

        pending.delete(recipe.id);
        await ctx.run("handlers.migrate", { recipe: recipe.id, from: waiting.from, to: waiting.to });
    }
}
