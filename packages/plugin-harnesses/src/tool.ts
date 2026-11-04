/**
 * The `harness` entity for a tool written under `tools` that no plugin provides: it runs
 * the tool's `command`, with nothing else known about it.
 */

import fs from "node:fs";
import { ConfigError, SousError, type Context } from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-host/types";
import { promptFilePath, toolSettings, type PartialToolSettings } from "./settings.js";
import type { HarnessEntity, HarnessLaunchResult, HeadlessRequest, HeadlessRun } from "./types.js";

/**
 * The most bytes one argument may hold on Linux (`MAX_ARG_STRLEN`). A longer prompt file fails to
 * start with a bare `spawn E2BIG`, so it is refused first with its size.
 */
export const MAX_ARGUMENT_BYTES = 128 * 1024;

/** The arguments of an interactive run: configured, then the user's, then the prompt file's content. */
export function launchArguments(
    settings: { args?: string[]; promptFile?: string },
    extra: readonly string[],
    ctx: Pick<Context, "project">,
): string[] {
    const args = [...(settings.args ?? []), ...extra];
    const file = promptFilePath(settings, ctx);

    if (file !== undefined) {
        if (!fs.existsSync(file)) {
            throw new ConfigError(`promptFile not found: ${file}`);
        }

        const content = fs.readFileSync(file, "utf8");
        const bytes = Buffer.byteLength(content, "utf8");

        if (bytes >= MAX_ARGUMENT_BYTES) {
            throw new ConfigError(`The prompt file is too large to pass as one argument (${kib(bytes)}, limit 128 KiB): ${file}`, {
                details: ["Shorten the prompt file, or have the tool read it some other way."],
            });
        }

        args.push(content);
    }

    return args;
}

/** A size in KiB, with one decimal: `144.2 KiB`. */
function kib(bytes: number): string {
    return `${(bytes / 1024).toFixed(1)} KiB`;
}

/** A headless run's arguments: its own, or, when it names no command, the interactive ones. */
function headlessArguments(settings: PartialToolSettings): string[] {
    return [...(settings.headless?.args ?? (settings.headless?.command === undefined ? (settings.args ?? []) : []))];
}

/** A `harness` entity that only runs a command from the config. */
export function toolHarness(id: string): HarnessEntity {
    return {
        id,
        description: `The tool "${id}", as written under "tools" in the config.`,

        async launch(args, ctx): Promise<HarnessLaunchResult> {
            const settings = toolSettings(ctx, id);

            if (settings.command === undefined) {
                throw new ConfigError(`tools.${id} has no "command".`, { details: [`Set tools.${id}.command in your config.`] });
            }

            return ctx.services.get("host.processes").runInteractive(settings.command, launchArguments(settings, args, ctx), {
                ...(ctx.project ? { cwd: ctx.project.root } : {}),
                env: ctx.env,
                label: id,
            });
        },

        async runHeadless(request: HeadlessRequest, ctx): Promise<HeadlessRun> {
            const settings = toolSettings(ctx, id);
            const command = settings.headless?.command ?? settings.command;

            if (command === undefined) {
                throw new ConfigError(`tools.${id} has no "command" or "headless.command".`);
            }

            const result = await ctx.services.get("host.processes").run(command, headlessArguments(settings), {
                ...(request.cwd ?? ctx.project?.root ? { cwd: (request.cwd ?? ctx.project?.root)! } : {}),
                env: ctx.env,
                input: request.prompt,
                ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
                ...(request.signal === undefined ? {} : { signal: request.signal }),
                label: `${id} (headless)`,
            });

            if (result.timedOut) {
                throw new SousError(`${id} did not finish within ${request.timeoutMs}ms.`);
            }

            return { harness: id, exitCode: result.exitCode, output: result.stdout.trimEnd(), durationMs: result.durationMs, raw: result };
        },
    };
}
