/**
 * The `harness.run-headless` intent: runs a harness with no person at the keyboard, and reads its
 * transcript when asked (recipe tests use it).
 */

import { ConfigError, IntentOutputs, NotFoundError, type Context } from "@sous-io/plugin-api";
import type { RunHeadlessInput, RunHeadlessResult } from "./types.js";

/** Runs the intent. */
export async function handle(input: RunHeadlessInput, ctx: Context): Promise<IntentOutputs<RunHeadlessResult>> {
    const capable = ctx.entities.list("harness").filter((harness) => typeof harness.runHeadless === "function");
    const names = capable.map((harness) => harness.id).join(", ") || "(none)";
    let harness = input.harness === undefined ? undefined : ctx.entities.get("harness", input.harness);

    if (input.harness === undefined) {
        if (capable.length !== 1) {
            throw new ConfigError(
                capable.length === 0 ? "No harness can run headless." : "Several harnesses can run headless; name one with --harness.",
                { details: [`Harnesses that can: ${names}`] },
            );
        }

        harness = capable[0];
    }

    if (harness === undefined) {
        throw new NotFoundError("harness", input.harness!, `No harness named '${input.harness}'.`, { details: [`Harnesses that can run headless: ${names}`] });
    }

    if (harness.runHeadless === undefined) {
        throw new ConfigError(`The harness '${harness.id}' cannot run headless.`, { details: [`Harnesses that can: ${names}`] });
    }

    const run = await harness.runHeadless(
        {
            prompt: input.prompt,
            ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        },
        ctx,
    );

    if (!input.transcript) {
        return IntentOutputs.of<RunHeadlessResult>({ run });
    }

    if (harness.readTranscript === undefined) {
        throw new ConfigError(`The harness '${harness.id}' cannot read a transcript.`);
    }

    return IntentOutputs.of<RunHeadlessResult>({ run, transcript: await harness.readTranscript(run, ctx) });
}
