/**
 * Reading the `tools` settings. Entity methods call these when they run, so a harness always sees
 * the user's current settings.
 */

import path from "node:path";
import { jsonSchema, type ConfigReader, type Context } from "@sous-io/plugin-api";
import type { ToolSettings } from "./types.js";

/** The `tools` key's path. */
export const TOOLS_KEY = "tools";

/** What the user may have written for one tool: `command` can be left out for a tool a plugin knows. */
export type PartialToolSettings = Partial<ToolSettings>;

/** The `tools` config key (C56). */
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

/** The user's settings for one tool, or an empty object. Never throws on a missing key. */
export function toolSettings(config: Pick<ConfigReader, "get">, id: string): PartialToolSettings {
    const value = config.get<PartialToolSettings>(`${TOOLS_KEY}.${id}`);

    return value && typeof value === "object" ? value : {};
}

/** Where a tool's `promptFile` is, relative paths being under the project root. */
export function promptFilePath(settings: PartialToolSettings, ctx: Pick<Context, "project">): string | undefined {
    if (settings.promptFile === undefined) {
        return undefined;
    }

    return path.resolve(ctx.project?.root ?? process.cwd(), settings.promptFile);
}
