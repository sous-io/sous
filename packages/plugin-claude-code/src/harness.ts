/**
 * The `claude` harness: Claude Code's `claude` command, started interactively or headless.
 *
 * The user's settings are `tools.claude` (`command`, `args`, `promptFile`, `headless`), read when a
 * method runs. With nothing set, the command is `claude`.
 */

import { SousError } from "@sous-io/plugin-api";
import type { HarnessEntity, HeadlessRun, ToolSettings, Transcript } from "@sous-io/plugin-harnesses/types";
import { launchArguments } from "@sous-io/plugin-harnesses";
import type {} from "@sous-io/plugin-host/types";
import { finalText, parseStream, transcriptEntries, type ClaudeRaw } from "./transcript.js";
import type { ClaudeCodePluginOptions, ClaudeCodeHarness } from "./types.js";

/** The harness's id, and the key its settings are under. */
export const HARNESS_ID = "claude";

/** The command used when `tools.claude.command` is not set. */
export const DEFAULT_COMMAND = "claude";

/** The arguments every headless run gets. */
export const HEADLESS_ARGS = ["-p", "--output-format", "stream-json", "--verbose"] as const;

/** The harness. */
export const claudeHarness: ClaudeCodeHarness = {
    id: HARNESS_ID,
    description: "Claude Code, started with the `claude` command.",

    async launch(args, ctx) {
        const settings = ctx.config.get<Partial<ToolSettings>>("tools.claude") ?? {};

        return ctx.services.get("host.processes").runInteractive(settings.command ?? DEFAULT_COMMAND, launchArguments(settings, args, ctx), {
            ...(ctx.project ? { cwd: ctx.project.root } : {}),
            env: ctx.env,
            label: HARNESS_ID,
        });
    },

    async runHeadless(request, ctx): Promise<HeadlessRun> {
        const settings = ctx.config.get<Partial<ToolSettings>>("tools.claude") ?? {};
        const model = request.model ?? ctx.options<ClaudeCodePluginOptions>()?.model;
        const command = settings.headless?.command ?? settings.command ?? DEFAULT_COMMAND;
        const args = [...(settings.headless?.args ?? []), ...HEADLESS_ARGS, ...(model === undefined ? [] : ["--model", model]), ...passed(request.options)];
        const cwd = request.cwd ?? ctx.project?.root;

        // The prompt goes on standard input, so its length and its dashes never matter.
        const result = await ctx.services.get("host.processes").run(command, args, {
            ...(cwd === undefined ? {} : { cwd }),
            env: ctx.env,
            input: request.prompt,
            ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            label: `${HARNESS_ID} (headless)`,
        });

        if (result.timedOut) {
            throw new SousError(`claude did not finish within ${request.timeoutMs}ms.`);
        }

        const raw: ClaudeRaw = { stdout: result.stdout, stderr: result.stderr };
        const output = finalText(parseStream(result.stdout));

        return { harness: HARNESS_ID, exitCode: result.exitCode, output, durationMs: result.durationMs, raw };
    },

    readTranscript(run): Transcript {
        const raw = run.raw as Partial<ClaudeRaw> | undefined;

        return { harness: HARNESS_ID, entries: transcriptEntries(parseStream(raw?.stdout ?? "")) };
    },
} satisfies HarnessEntity & { id: "claude" };

/** Extra command-line arguments a caller passes in `options.args`. */
function passed(options: Readonly<Record<string, unknown>> | undefined): string[] {
    const args = options?.args;

    return Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === "string") : [];
}
