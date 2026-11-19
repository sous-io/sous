/**
 * The `launch` intent: builds, then starts a harness (today's `sous launch`).
 */

import { ConfigError, IntentOutputs, NotFoundError, SousError, type Context } from "@sous-io/sous-plugin-api";
import type { BuildResult } from "@sous-io/sous-plugin-build/types";
import type { HarnessLaunchResult, LaunchInput, LaunchResult } from "./types.js";

/** A small delay between sessions of `--continuous`, so an immediate crash does not spin. */
const RESTART_DELAY_MS = 150;

/** The ids of the harnesses that can launch. */
export function launchable(ctx: Pick<Context, "entities">): string[] {
    return ctx.entities
        .list("harness")
        .filter((harness) => typeof harness.launch === "function")
        .map((harness) => harness.id);
}

/**
 * The tools a name that was not found probably meant: those whose id starts with it and a hyphen.
 * A harness id names its tool in full (`claude-code`, not `claude`), so a short name gets a hint
 * rather than working as an alias.
 *
 * ```ts
 * meant("claude", ["claude-code", "codex"]);
 * // -> ["Did you mean: sous launch claude-code"]
 * ```
 */
export function meant(id: string, available: readonly string[]): string[] {
    const close = available.filter((candidate) => candidate.startsWith(`${id}-`));

    return close.length === 0 ? [] : [`Did you mean: ${close.map((candidate) => `sous launch ${candidate}`).join(", or ")}`];
}

/** Runs the intent. */
export async function handle(input: LaunchInput, ctx: Context): Promise<IntentOutputs<LaunchResult>> {
    const [id, ...passThrough] = input.tool;

    if (id === undefined) {
        throw new ConfigError("Name the tool to launch, such as: sous launch claude-code", { details: [`Available tools: ${launchable(ctx).join(", ") || "(none)"}`] });
    }

    const harness = ctx.entities.get("harness", id);

    if (harness?.launch === undefined) {
        const where = ctx.project?.configPath ? ` in ${ctx.project.configPath}` : "";

        throw new NotFoundError("harness", id, `Tool '${id}' not found${where}.`, {
            details: [...meant(id, launchable(ctx)), `Available tools: ${launchable(ctx).join(", ") || "(none)"}`],
        });
    }

    let build: BuildResult | undefined;
    let last: HarnessLaunchResult;
    let sessions = 0;

    do {
        // A failed build stops here: the agent would otherwise start on outputs the build could not bring up to date.
        if (!input.noBuild) {
            build = (await ctx.run("build")).toPlain();

            if (!build.ok) {
                throw new ConfigError(
                    `The build failed, so ${id} was not started. Fix the errors listed above, or pass --no-build to start it with the outputs as they are.`,
                );
            }
        }

        sessions++;
        await ctx.emit("harnesses.launched", { harness: id, args: passThrough, session: sessions });
        ctx.reporter.notice(`Launching ${id}`);

        try {
            last = await harness.launch(passThrough, ctx);
        } catch (error) {
            if (error instanceof SousError) {
                throw error;
            }

            throw new SousError(`Failed to launch '${id}': ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }

        if (input.continuous) {
            await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
        }
    } while (input.continuous);

    // The build reported as it ran and the tool owned the terminal, so the result holds only data.
    return IntentOutputs.of<LaunchResult>({ harness: id, last, sessions, ...(build === undefined ? {} : { build }) });
}
