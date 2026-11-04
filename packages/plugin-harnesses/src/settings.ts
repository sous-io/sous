/**
 * Reading the `tools` settings. Entity methods call these when they run, so a harness always sees
 * the user's current settings.
 */

import path from "node:path";
import { jsonSchema, type Context } from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-variables/types";
import type { ToolSettings } from "./types.js";

/** The `tools` key's path. */
export const TOOLS_KEY = "tools";

/** What the user may have written for one tool: `command` can be left out for a tool a plugin knows. */
export type PartialToolSettings = Partial<ToolSettings>;

/** The `tools` config key. */
export const toolsKeySchema = jsonSchema<Record<string, PartialToolSettings>>({
    type: "object",
    additionalProperties: {
        type: "object",
        properties: {
            command: { type: "string", description: "The command to run." },
            args: { type: "array", items: { type: "string" }, description: "Arguments always passed, before yours." },
            promptFile: { type: "string", description: "A file whose content is passed as the last argument." },
            headless: {
                type: "object",
                properties: {
                    command: { type: "string" },
                    args: { type: "array", items: { type: "string" } },
                },
                additionalProperties: false,
                description: "The command and arguments for a headless run; the prompt is sent on standard input.",
            },
        },
        additionalProperties: false,
    },
    default: {},
});

/**
 * The user's settings for one tool, or an empty object, with every `${var}` filled in from the
 * config's variables. Never throws on a missing key.
 *
 * `command`, `promptFile` and `headless.command` are values sous acts on, so an unknown `${name}`
 * in them fails with a `ConfigError`. In `args`, only the names sous knows are replaced: an
 * argument may hold a literal `${...}` meant for the tool itself.
 *
 * ```ts
 * // tools: { codex: { command: "codex", promptFile: "${projectRoot}/AGENTS.md" } }
 * toolSettings(ctx, "codex");
 * // { command: "codex", promptFile: "/home/me/project/AGENTS.md" }
 * ```
 */
export function toolSettings(ctx: Pick<Context, "config" | "services">, id: string): PartialToolSettings {
    const value = ctx.config.get<PartialToolSettings>(`${TOOLS_KEY}.${id}`);

    if (!value || typeof value !== "object") {
        return {};
    }

    return withVariables(value, ctx, `${TOOLS_KEY}.${id}`);
}

/** One tool's settings with `${var}` filled in, when the variables plugin is loaded. */
function withVariables(settings: PartialToolSettings, ctx: Pick<Context, "services">, key: string): PartialToolSettings {
    if (!ctx.services.has("variables.resolver")) {
        return settings;
    }

    const resolver = ctx.services.get("variables.resolver");
    const scope = resolver.scope();
    const strict = (text: string | undefined, field: string) => (text === undefined ? undefined : resolver.substituteStrict(text, scope, `${key}.${field}`));
    const loose = (args: readonly string[] | undefined) => args?.map((arg) => resolver.substitute(arg, scope));
    const out: PartialToolSettings = { ...settings };

    assign(out, "command", strict(settings.command, "command"));
    assign(out, "promptFile", strict(settings.promptFile, "promptFile"));
    assign(out, "args", loose(settings.args));

    if (settings.headless !== undefined) {
        const headless = { ...settings.headless };

        assign(headless, "command", strict(settings.headless.command, "headless.command"));
        assign(headless, "args", loose(settings.headless.args));
        out.headless = headless;
    }

    return out;
}

/** Sets a field when the value is defined, leaving the object's other fields alone. */
function assign<T extends object, K extends keyof T>(target: T, field: K, value: T[K] | undefined): void {
    if (value !== undefined) {
        target[field] = value;
    }
}

/** Where a tool's `promptFile` is, relative paths being under the project root. */
export function promptFilePath(settings: PartialToolSettings, ctx: Pick<Context, "project">): string | undefined {
    if (settings.promptFile === undefined) {
        return undefined;
    }

    return path.resolve(ctx.project?.root ?? process.cwd(), settings.promptFile);
}
