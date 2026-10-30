/**
 * What an intent that changed recipes runs afterwards (`vars.ask`, `build`), through `ctx.run`, so
 * every front end gets the same steps (S6, "vars and repos").
 *
 * The intent refreshes the config (`ctx.refreshConfig()`) after writing, so the follow-ups see
 * the change; `vars.ask` refreshes it again after answering, so `build` sees the answers.
 */

import type { Context } from "@sous-io/plugin-api";
import type { AnswerFlags, IntentFollowUp, RecipeChangeFlags } from "../types.js";
import { hasIntent } from "./util.js";

/** Runs `vars.ask` for some recipes, unless there is nothing to ask or no plugin provides it. */
export async function askFollowUp(ctx: Context, flags: RecipeChangeFlags & AnswerFlags, recipes: readonly string[]): Promise<IntentFollowUp> {
    if (flags.dryRun === true) {
        return { intent: "vars.ask", skipped: "--dry-run" };
    }

    if (!hasIntent(ctx, "vars.ask")) {
        return { intent: "vars.ask", skipped: "no plugin provides vars.ask" };
    }

    if (recipes.length === 0 && flags.answer === undefined && flags.answersFile === undefined) {
        return { intent: "vars.ask", skipped: "nothing new to ask" };
    }

    const result = await ctx.run("vars.ask", {
        ...(recipes.length === 1 ? { recipe: recipes[0] } : {}),
        ...(flags.answer === undefined ? {} : { answer: flags.answer }),
        ...(flags.answersFile === undefined ? {} : { answersFile: flags.answersFile }),
    });

    // The answers were written to a config file: the build after this sees them.
    if (ctx.chain !== undefined && !ctx.chain.parallel) {
        await ctx.refreshConfig();
    }

    return { intent: "vars.ask", result };
}

/** Runs `build`, unless `--no-build` or `--dry-run` was given or no plugin provides it. */
export async function buildFollowUp(ctx: Context, flags: RecipeChangeFlags): Promise<IntentFollowUp> {
    if (flags.dryRun === true) {
        return { intent: "build", skipped: "--dry-run" };
    }

    if (flags.noBuild === true) {
        return { intent: "build", skipped: "--no-build" };
    }

    if (!hasIntent(ctx, "build")) {
        return { intent: "build", skipped: "no plugin provides build" };
    }

    // The build reports as it goes, so its heading comes first, as before the refactor.
    ctx.reporter.note("Building the project");

    return { intent: "build", result: await ctx.run("build", {}) };
}
