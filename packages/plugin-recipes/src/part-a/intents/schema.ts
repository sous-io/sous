/**
 * The input fields part A's intents share, as JSON Schema properties, and their CLI options. Every
 * input is a flag; names and spellings keep today's CLI (`--yes`, `-y`, `--force`, `--trust`,
 * `--latest`, `--remote`).
 */

import { jsonSchema, type CliFlagOptions, type JsonSchema, type SousSchema } from "@sous-io/plugin-api";

/** An object schema of the given properties, the `required` ones listed. */
export function inputSchema<T>(properties: Record<string, JsonSchema>, required: readonly string[] = []): SousSchema<T, T> {
    return jsonSchema<T>({ type: "object", properties, required, additionalProperties: false });
}

export const dryRun: JsonSchema = { type: "boolean", description: "Show what would change, writing nothing" };

export const noBuild: JsonSchema = { type: "boolean", description: "Change it without rebuilding the project afterwards" };

export const yes: JsonSchema = { type: "boolean", description: "Answer yes to every question, trusting new repositories without asking" };

export const acceptFirst: JsonSchema = { type: "boolean", description: "When a ref matches several things, take the first one listed" };

export const answer: JsonSchema = {
    type: "array",
    items: { type: "string" },
    description: "Answer a recipe question ahead of time, as name=value (repeatable)",
};

export const answersFile: JsonSchema = { type: "string", description: "A file of answers to recipe questions (YAML, JSON, JSONC or .env)" };

export const latest: JsonSchema = { type: "boolean", description: "Check upstream for newer indexes first" };

export const installed: JsonSchema = { type: "boolean", description: "Show only what this project has installed, never going upstream" };

/** The browsing flags. */
export const browsing: Record<string, JsonSchema> = { latest, installed };

/** CLI options of `--yes`. */
export const yesFlag: CliFlagOptions = { short: "y", aliases: ["force", "trust"] };

/** CLI options of `--yes` where today's CLI has no `--trust`. */
export const yesFlagNoTrust: CliFlagOptions = { short: "y", aliases: ["force"] };

/** CLI options of `--latest`. */
export const latestFlag: CliFlagOptions = { aliases: ["remote"] };
