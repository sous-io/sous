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

/** The `memory-target` entity kind. `filter` and `format`, when given, must be functions. */
export const memoryTargetSchema: SousSchema<MemoryTargetEntity, MemoryTargetEntity> = refine(
    jsonSchema<MemoryTargetEntity>({
        type: "object",
        required: ["id", "fileName"],
        properties: {
            id: { type: "string", description: "The target's id: `claude-code`." },
            harness: { type: "string", description: "The `harness` entity that reads the file." },
            fileName: { type: "string", description: "The file name: `CLAUDE.md`, `AGENTS.md`." },
            readIn: {
                enum: ["project-root", "any-directory"],
                default: "project-root",
                description: "Where the harness reads the file; `any-directory` also makes it a pointer file.",
            },
            directory: { type: "string", description: "Where the file is written, relative to the project root." },
        },
    }),
    (target) =>
        (["filter", "format"] as const)
            .filter((name) => target[name] !== undefined && typeof target[name] !== "function")
            .map((name) => ({ path: [name], message: "Expected a function." })),
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
