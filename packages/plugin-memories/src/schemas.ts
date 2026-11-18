/**
 * The schemas plugin-memories registers: the `memory-target` entity kind and the `recipes.memories`
 * config key. Written with `jsonSchema`, so the plugin needs no schema library.
 */

import { jsonSchema, type SousSchema, type StandardSchemaV1 } from "@sous-io/plugin-api";
import { compileRecipeKeyMatcher } from "./key-matcher.js";
import { EXCLUDE_KEY, FIRST_KEY } from "./listing.js";
import type { MemoriesSettings, MemoryTargetEntity } from "./types.js";

type Issue = StandardSchemaV1.Issue;

/** A schema that runs `base`, then `extra` on a value `base` accepted. */
function refine<T>(base: SousSchema<T, T>, extra: (value: T) => Issue[]): SousSchema<T, T> {
    const standard = base["~standard"];

    return {
        "~standard": {
            ...standard,
            validate(value) {
                const result = standard.validate(value) as StandardSchemaV1.Result<T>;

                if (result.issues) {
                    return result;
                }

                const issues = extra(result.value);

                return issues.length > 0 ? { issues } : result;
            },
        },
    };
}

/**
 * The `memory-target` entity kind. The fields it had before 1.0.20 (`fileName`, `directory`,
 * `readIn`, `filter`, `format`) are refused by name, so a plugin written for them fails clearly.
 */
export const memoryTargetSchema: SousSchema<MemoryTargetEntity, MemoryTargetEntity> = refine(
    jsonSchema<MemoryTargetEntity>({
        type: "object",
        required: ["id", "outputPath"],
        properties: {
            id: { type: "string", minLength: 1, description: "The target's id: `claude-code`, `codex`." },
            harness: { type: "string", description: "The `harness` entity that reads the file; its output is marked with it." },
            outputPath: {
                type: "string",
                minLength: 1,
                description: "The file to write; `${projectRoot}` and other variables allowed, a relative path is under the project root.",
            },
            prependWith: { type: "string", description: "A file included before the memories; skipped when it does not exist." },
            backupExisting: {
                type: "boolean",
                description: "Back up, warn about and overwrite a file sous did not write at outputPath.",
            },
        },
    }),
    (target) =>
        (["fileName", "directory", "readIn", "filter", "format"] as const)
            .filter((name) => (target as unknown as Record<string, unknown>)[name] !== undefined)
            .map((name) => ({
                path: [name],
                message: `"${name}" was removed from memory targets in sous 1.0.20: a memory target names the file it writes with "outputPath", and its content comes from .sous/MEMORIES.tpl.md.`,
            })),
);

/** One list of recipe keys: globs, or `/.../` regular expressions that must compile. */
function keyListIssues(entries: readonly string[], where: string, key: string): Issue[] {
    return entries.flatMap((entry, index) => {
        try {
            compileRecipeKeyMatcher([entry], `${where}[${index}]`, () => false);

            return [];
        } catch (error) {
            return [{ path: [key, index], message: error instanceof Error ? error.message : String(error) }];
        }
    });
}

/** The `recipes.memories` config key. */
export const memoriesSettingsSchema: SousSchema<MemoriesSettings, MemoriesSettings> = refine(
    jsonSchema<MemoriesSettings>({
        type: "object",
        additionalProperties: false,
        properties: {
            first: {
                type: "array",
                items: { type: "string" },
                default: [],
                description: "Recipe keys, globs or /regular expressions/ whose memories come first, in this order.",
            },
            exclude: {
                type: "array",
                items: { type: "string" },
                default: [],
                description: "Recipe keys, globs or /regular expressions/ whose memories are left out.",
            },
        },
        default: {},
        description: "Which recipe memories memory targets and the #memories view take, and in what order.",
    }),
    (settings) => [
        ...keyListIssues(settings.first, FIRST_KEY, "first"),
        ...keyListIssues(settings.exclude, EXCLUDE_KEY, "exclude"),
    ],
);
