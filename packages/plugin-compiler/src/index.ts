/**
 * plugin-compiler: compiling templates, includes, aliases, compilation settings, the built-in tags
 * and filter, the state file, writing outputs, pruning.
 *
 * The contract other plugins code against is `./types.ts`. Among
 * the built-in plugins only this one writes build outputs; others add compilation targets.
 */

import { definePlugin, jsonSchema, type PluginDefinition, type SousSchema } from "@sous-io/plugin-api";
import { AliasService } from "./aliases.js";
import { IncludeService } from "./includes.js";
import { compile, prune } from "./intents.js";
import { BUILT_IN_FILTERS, BUILT_IN_TAGS } from "./liquid/tags.js";
import { RuntimeCache } from "./runtime.js";
import { CONFIG_KEYS } from "./schema.js";
import { StateService } from "./state.js";
import type { CompileInput, CompilerPruneInput } from "./types.js";
import { WriterService } from "./writer.js";
import "./types.js";
import packageJson from "../package.json" with { type: "json" };

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-compiler";

/** Checks a `compilation-transform` entity: an id and a `transform` function. */
const transformSchema: SousSchema = {
    "~standard": {
        version: 1,
        vendor: "sous",
        validate: (value: unknown) => {
            const entry = value as { id?: unknown; transform?: unknown } | null;

            return typeof entry?.id === "string" && typeof entry.transform === "function"
                ? { value }
                : { issues: [{ message: "A compilation-transform entity needs an id and a transform function." }] };
        },
    },
};

const compileInput = jsonSchema<CompileInput>({
    type: "object",
    properties: {
        targets: { type: "array", items: { anyOf: [{ type: "string" }, { type: "integer" }] }, description: "Only these targets, by id or index." },
        changedFiles: { type: "array", items: { type: "string" }, description: "Only the targets whose sources include one of these files." },
        strict: { type: "boolean", description: "Warnings fail the compile." },
        rebuild: { type: "boolean", description: "Writes every output, changed or not." },
        dryRun: { type: "boolean", description: "Writes nothing." },
    },
    additionalProperties: false,
});

const pruneInput = jsonSchema<CompilerPruneInput>({
    type: "object",
    properties: {
        all: { type: "boolean", description: "Removes every file the compiler wrote, not only those no target produces." },
        dryRun: { type: "boolean", description: "Removes nothing." },
        report: { type: "boolean", description: "Reports each removed file as progress. Default: true." },
    },
    additionalProperties: false,
});

/** The plugin. */
export const compilerPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: packageJson.version,
    description: "Compiling templates, includes, aliases, compilation settings, the built-in tags and filters, the state file, writing outputs, pruning.",
    // Declared in this plugin's contract for plugin-recipes to implement, so sous does not warn about it.
    implementable: ["compiler.namespace-resolver"],
    dependsOn: {
        "@sous-io/plugin-liquid": `^${packageJson.version}`,
        "@sous-io/plugin-refs": `^${packageJson.version}`,
        "@sous-io/plugin-variables": `^${packageJson.version}`,
        "@sous-io/plugin-host": `^${packageJson.version}`,
    },

    register(sous) {
        const runtimes = new RuntimeCache();

        sous.entities.define("compilation-transform", transformSchema, { description: "A change to an output's path or contents before it is written." });

        for (const key of CONFIG_KEYS) {
            sous.entities.add("config-key", key);
        }

        for (const tag of BUILT_IN_TAGS) {
            sous.entities.add("liquid-tag", tag);
        }

        for (const filter of BUILT_IN_FILTERS) {
            sous.entities.add("liquid-filter", filter);
        }

        sous.services.add("compiler.aliases", (_config, ctx) => new AliasService(runtimes.for(ctx).aliases()), { lifetime: "config" });
        sous.services.add("compiler.includes", (_config, ctx) => new IncludeService(runtimes.for(ctx).includeEnvironment()), { lifetime: "config" });
        sous.services.add("compiler.state", (_config, ctx) => new StateService(runtimes.for(ctx).store()), { lifetime: "config" });
        sous.services.add(
            "compiler.writer",
            (_config, ctx) => {
                const runtime = runtimes.for(ctx);

                return new WriterService(runtime.store(), {
                    overwriteUntracked: runtime.settings().overwriteUntracked,
                    protectedRoots: runtime.protectedRoots(),
                });
            },
            { lifetime: "config" },
        );

        sous.intents.add({
            intent: "compiler.compile",
            summary: "Compile every compilation target into its outputs",
            internal: true,
            input: compileInput,
            handle: (input, ctx) => compile(input, ctx, runtimes.for(ctx)),
        });

        sous.intents.add({
            intent: "compiler.prune",
            summary: "Remove outputs no compilation target produces any more",
            internal: true,
            input: pruneInput,
            handle: (input, ctx) => prune(input, ctx, runtimes.for(ctx)),
        });
    },
});

export default compilerPlugin;

export { AliasService, buildAliasMap, resolveAliasPrefix } from "./aliases.js";
export { describeNamespaceProblem, IncludeService, planInclude, resolveIncludeFiles } from "./includes.js";
export { INCLUDE_LINE_PATTERN, looksLikeIncludeLine, resolveOutputPath, splitAliasKey, splitIncludeQuery, templateTwin } from "./paths.js";
export { hashContent, isProtectedPath } from "./state.js";
export type * from "./types.js";
