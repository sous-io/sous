/**
 * The schemas of plugin-build: its two config keys and the input of each intent. Written with
 * `jsonSchema` so the plugin needs no schema library, and the CLI and MCP get their flags and tools
 * from the same JSON Schema.
 */

import { jsonSchema, type SousSchema } from "@sous-io/plugin-api";
import type {
    BuildInput,
    BuildPrepareInput,
    BuildWatchInput,
    ClearInput,
    CompileCommandInput,
    PruneInput,
    RuntimeContextSettings,
    WatchSettings,
} from "./types.js";

/** The default of `watch.debounceMs`. */
export const DEFAULT_DEBOUNCE_MS = 200;

/** The default of `runtimeContext.branchPattern`, as before the refactor. */
export const DEFAULT_BRANCH_PATTERN = "PT-";

/** The `watch` config key. */
export const watchSettingsSchema: SousSchema<WatchSettings> = jsonSchema<WatchSettings>({
    type: "object",
    properties: {
        pollSeconds: {
            type: "integer",
            description: "How often watch mode checks upstream for newer recipes, in seconds; 0 never. Default: store.watchPollSeconds.",
        },
        paths: {
            type: "array",
            items: { type: "string" },
            default: [],
            description: "More files, directories or globs whose change triggers a full rebuild.",
        },
        debounceMs: {
            type: "integer",
            default: DEFAULT_DEBOUNCE_MS,
            description: "How long to wait for more changes before building, in milliseconds.",
        },
    },
    additionalProperties: false,
});

/** The `runtimeContext` config key. */
export const runtimeContextSchema: SousSchema<RuntimeContextSettings> = jsonSchema<RuntimeContextSettings>({
    type: "object",
    properties: {
        gitRoot: { type: "string", description: "The git repository branch detection reads (${var} allowed)." },
        outputPath: { type: "string", description: "Where the runtime context file is written." },
        taskFileRoot: { type: "string", description: "The directory task files live in." },
        branchPattern: { type: "string", description: "A regular expression; only matching branches look for a task file." },
    },
    required: ["gitRoot", "outputPath", "taskFileRoot"],
    additionalProperties: false,
});

const boolean = (description: string) => ({ type: "boolean" as const, description });

/** `build`. */
export const buildInputSchema: SousSchema<BuildInput> = jsonSchema<BuildInput>({
    type: "object",
    properties: {
        noPrune: boolean("Skip the prune step"),
        noCompile: boolean("Skip the compile step (prune only)"),
        rebuild: boolean("Ignore cached hashes and reprocess all outputs"),
        dryRun: boolean("Print what would be written/pruned without making changes"),
        strict: boolean("Treat compile warnings as errors"),
        watch: boolean("Watch source files and rebuild on changes"),
        changedFiles: {
            type: "array",
            items: { type: "string" },
            description: "Only rebuild the targets that include one of these files, preparing nothing",
        },
    },
    additionalProperties: false,
});

/** `compile`. */
export const compileInputSchema: SousSchema<CompileCommandInput> = jsonSchema<CompileCommandInput>({
    type: "object",
    properties: {
        strict: boolean("Treat compile warnings as errors"),
        rebuild: boolean("Ignore cached hashes and reprocess all outputs"),
        dryRun: boolean("Print what would be written without making changes"),
        watch: boolean("Watch source files and recompile on changes"),
        changedFiles: {
            type: "array",
            items: { type: "string" },
            description: "Only recompile the targets that include one of these files",
        },
    },
    additionalProperties: false,
});

/** `build.prepare`. */
export const prepareInputSchema: SousSchema<BuildPrepareInput> = jsonSchema<BuildPrepareInput>({
    type: "object",
    properties: {
        dryRun: boolean("Show what preparing would change, writing nothing"),
        offline: boolean("Never go upstream"),
    },
    additionalProperties: false,
});

/** `prune`. */
export const pruneInputSchema: SousSchema<PruneInput> = jsonSchema<PruneInput>({
    type: "object",
    properties: {
        dryRun: boolean("Print what would be pruned without deleting"),
    },
    additionalProperties: false,
});

/** `clear`. */
export const clearInputSchema: SousSchema<ClearInput> = jsonSchema<ClearInput>({
    type: "object",
    properties: {
        force: boolean("Delete without asking"),
        dryRun: boolean("Print what would be deleted without deleting"),
    },
    additionalProperties: false,
});

/** `build.watch`. */
export const watchInputSchema: SousSchema<BuildWatchInput> = jsonSchema<BuildWatchInput>({
    type: "object",
    properties: {
        compileOnly: boolean("Submit compile chains instead of build chains"),
        strict: boolean("Treat compile warnings as errors"),
        pollSeconds: { type: "integer", description: "How often to check upstream for newer recipes, in seconds; 0 never" },
        rebuild: boolean("Reprocess all outputs on every change"),
        noPrune: boolean("Skip the prune step on every build"),
        dryRun: boolean("Write nothing on any build"),
    },
    additionalProperties: false,
});
