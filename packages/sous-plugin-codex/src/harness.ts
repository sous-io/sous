/**
 * The `codex` harness: OpenAI's `codex` command, started interactively.
 *
 * The user's settings are `tools.codex` (`command`, `args`, `promptFile`), read when `launch` runs.
 * With nothing set, the command is `codex`. There is no headless run: Codex's non-interactive
 * mode (`codex exec`) has its own output format, and nothing here has been run against Codex.
 */

import { launchArguments, toolSettings } from "@sous-io/sous-plugin-harnesses";
import type {} from "@sous-io/sous-plugin-host/types";
import type { CodexHarness } from "./types.js";

/** The harness's id, and the key its settings are under. */
export const HARNESS_ID = "codex";

/** The command used when `tools.codex.command` is not set. */
export const DEFAULT_COMMAND = "codex";

/** The harness. */
export const codexHarness: CodexHarness = {
    id: HARNESS_ID,
    description: "Codex, started with the `codex` command.",

    async launch(args, ctx) {
        const settings = toolSettings(ctx, HARNESS_ID);

        return ctx.services.get("host.processes").runInteractive(settings.command ?? DEFAULT_COMMAND, launchArguments(settings, args, ctx), {
            ...(ctx.project ? { cwd: ctx.project.root } : {}),
            env: ctx.env,
            label: HARNESS_ID,
        });
    },
};
