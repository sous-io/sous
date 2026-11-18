/**
 * plugin-init: Scaffolding a project's .sous/ (sous init).
 *
 * The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, jsonSchema, type PluginDefinition } from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-build/types";
import type {} from "@sous-io/plugin-config-files/types";
import type {} from "@sous-io/plugin-host/types";
import type { InitInput } from "./types.js";
import "./types.js";
import packageJson from "../package.json" with { type: "json" };

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-init";

const initInput = jsonSchema<InitInput>({
    type: "object",
    properties: {
        directory: { type: "string", description: "Project directory to set up (defaults to the current one)." },
        name: { type: "string", description: "Display name for the project (defaults to the directory's own name)." },
        yes: { type: "boolean", default: false, description: "Accept the default answer to every question init asks: set the project up even inside another one, and move the included files." },
        moveIncludes: { type: "boolean", default: false, description: "Move the files the existing CLAUDE.md or AGENTS.md include into .sous/includes/ (the default)." },
        copyIncludes: { type: "boolean", default: false, description: "Copy the files the existing CLAUDE.md or AGENTS.md include into .sous/includes/, keeping the originals." },
        leaveIncludes: { type: "boolean", default: false, description: "Leave the files the existing CLAUDE.md or AGENTS.md include where they are." },
        dryRun: { type: "boolean", default: false, description: "Show the files that would be written without writing them." },
        noBuild: { type: "boolean", default: false, description: "Write the setup without running the first build." },
    },
    additionalProperties: false,
});

/** The plugin. */
export const initPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: packageJson.version,
    description: "Scaffolding a project's .sous/ (sous init).",
    dependsOn: {
        "@sous-io/plugin-build": `^${packageJson.version}`,
        "@sous-io/plugin-config-files": `^${packageJson.version}`,
        "@sous-io/plugin-host": `^${packageJson.version}`,
    },

    register(sous) {
        sous.intents.add({
            intent: "init",
            summary: "Set a project up for sous: import its agent files into a new .sous/ directory, then run the first build",
            input: initInput,
            changesConfig: true,
            cli: {
                positional: ["directory"],
                examples: ["sous init", "sous init ./my-project", "sous init --name 'My Project' --no-build", "sous init --leave-includes", "sous init --dry-run"],
                flags: { yes: { short: "y", aliases: ["force"] } },
            },
            agent: {
                usage: "Set up a new project. Pass yes so no question is asked (or moveIncludes, copyIncludes or leaveIncludes to choose what happens to the files the existing instructions include), and dryRun first to see the files.",
            },
            load: () => import("./init.js"),
        });
    },
});

export default initPlugin;

export {
    buildConfigJsonc,
    buildEnvDefaults,
    buildEnvLocalExample,
    buildMemoriesSource,
    buildRepoStarterMemory,
    buildStarterMemory,
    CONFIG_FILE_NAME,
    configSchemaUrl,
    MEMORIES_DEFAULT_LINES,
    MEMORIES_SOURCE_RELATIVE_PATH,
    ROOT_IGNORE_LINES,
    STARTER_MEMORY_RELATIVE_PATH,
} from "./templates.js";
export { applyImport, findReferences, rewriteReferences, scanImport, settleFates } from "./import.js";
export { planPackageJson } from "./package-json.js";
export { IGNORE_BLOCK_LINES, isRecipeRepository, scaffoldProject, sousDirFor } from "./scaffold.js";
export type * from "./types.js";
