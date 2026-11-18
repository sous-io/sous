/**
 * `@sous-io/sous-plugin-editor`: edits to files Sous does not own.
 *
 * - The `editor.edits` config key: the master list. Recipes (through `sous-plugin-recipes`), plugins
 *   and the project add entries to it; nothing else is read (law L8).
 * - The internal `editor.apply` intent: applies the list after the compiler, undoes what is no
 *   longer declared, checks the assertions, writes each file once and keeps the history.
 * - The `editor` service, for direct usage: open a file, apply operations, get the text, write it.
 * - For plugins: `editor(config).file(path).at(path).<operation>(...)` and `expect(...)`, which
 *   record entries in the list; and the types of the object style.
 *
 * The contract other plugins code against is `./types.ts`.
 */

import path from "node:path";
import { definePlugin, jsonSchema, type PluginDefinition } from "@sous-io/sous-plugin-api";
import { createTokenCounter } from "@sous-io/sous-plugin-compiler";
import type {} from "@sous-io/sous-plugin-variables/types";
import { assertionsCheck } from "./doctor-check.js";
import { applyIntent } from "./intent.js";
import { EDITOR_CONFIG_KEY } from "./schema.js";
import { EditorServiceImpl } from "./service.js";
import type { EditorApplyInput } from "./types.js";
import "./types.js";
import packageJson from "../package.json" with { type: "json" };

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/sous-plugin-editor";

const applyInput = jsonSchema<EditorApplyInput>({
    type: "object",
    properties: {
        dryRun: { type: "boolean", description: "Works everything out and reports it, writing nothing." },
        ignoreFailedAssertions: {
            type: "boolean",
            description: "A failed assertion at level error is printed as a warning, and the build carries on.",
        },
    },
    additionalProperties: false,
});

/** The plugin. */
export const editorPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: packageJson.version,
    description: "Edits to files Sous does not own: declared, recorded, undone and checked by assertions; and the editor service.",
    dependsOn: {
        "@sous-io/sous-plugin-compiler": `^${packageJson.version}`,
        "@sous-io/sous-plugin-variables": `^${packageJson.version}`,
        "@sous-io/sous-plugin-doctor": `^${packageJson.version}`,
    },

    register(sous) {
        sous.entities.add("config-key", EDITOR_CONFIG_KEY);

        sous.services.add(
            "editor",
            (config, ctx) => {
                const root = ctx.project?.root ?? path.resolve("/");
                const resolver = ctx.services.has("variables.resolver") ? ctx.services.get("variables.resolver") : undefined;
                const scope = () => resolver?.scopeIn(config);
                let counter: Promise<{ count(text: string): number }> | undefined;

                return new EditorServiceImpl(
                    (file) => {
                        const substituted = resolver === undefined ? file : resolver.substitute(file, scope()!);

                        return path.resolve(root, resolver === undefined ? substituted : resolver.normalizePath(substituted));
                    },
                    async (text) => {
                        counter ??= createTokenCounter();

                        return (await counter).count(text);
                    },
                );
            },
            { lifetime: "config" },
        );

        sous.intents.add({
            intent: "editor.apply",
            summary: "Apply the declared edits to files Sous does not own, undo the ones no longer declared, and check the assertions",
            internal: true,
            input: applyInput,
            handle: (input, ctx) => applyIntent(input, ctx),
        });

        sous.entities.add("doctor-check", assertionsCheck);
    },
});

export default editorPlugin;

export { editor, expect, Expectation, CHAIN_OPERATION_NAMES } from "./chain.js";
export type { EditorChain, ExpectSubject, FileHandle, FileSettings, SilenceHandle, SizeReference, ValueHandle, ValueOperations } from "./chain.js";
export { CHECKS } from "./checks.js";
export { formatForFile, openDocument, UnsupportedFormatError } from "./documents-adapter.js";
export { DEFAULT_SETTINGS, EDITS_KEY, normalizeEntry } from "./entries.js";
export { HISTORY_FILE_NAME } from "./history.js";
export { declaredEntries } from "./intent.js";
export { assertionsCheck, checkAssertions } from "./doctor-check.js";
export { ALIASES, OPERATIONS, operationInfo, resolveOperation } from "./operations.js";
export { editorSchema } from "./schema.js";
export type { ItemPlace, RelocateOperations } from "./operations-relocate.js";

export type * from "./types.js";
