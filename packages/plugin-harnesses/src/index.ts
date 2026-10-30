/**
 * plugin-harnesses: The harness entity, launching a harness, headless runs, and the tools settings.
 *
 * S6, "Harnesses: plugin-harnesses". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, jsonSchema, type PluginDefinition } from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-build/types";
import type {} from "@sous-io/plugin-host/types";
import { toolsContributor } from "./contributor.js";
import { TOOLS_KEY, toolsKeySchema } from "./settings.js";
import type { HarnessEntity, LaunchInput, RunHeadlessInput } from "./types.js";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-harnesses";

/** The `harness` kind's schema. The methods are functions, which JSON Schema cannot describe. */
const harnessSchema = jsonSchema<HarnessEntity>({
    type: "object",
    required: ["id"],
    properties: {
        id: { type: "string", description: "What `sous launch <id>` names: `claude`." },
        description: { type: "string" },
    },
});

const launchInput = jsonSchema<LaunchInput>({
    type: "object",
    required: ["tool"],
    properties: {
        tool: { type: "array", items: { type: "string" }, description: "The tool, then arguments passed through to it." },
        noBuild: { type: "boolean", default: false, description: "Skip sous build before launching." },
        continuous: { type: "boolean", default: false, description: "Restart the tool automatically on exit." },
    },
    additionalProperties: false,
});

const runHeadlessInput = jsonSchema<RunHeadlessInput>({
    type: "object",
    required: ["prompt"],
    properties: {
        harness: { type: "string", description: "The harness to run. Default: the only one that can run headless." },
        prompt: { type: "string", description: "The prompt." },
        cwd: { type: "string", description: "The directory it runs in. Default: the project root." },
        model: { type: "string", description: "A model, when the harness lets one be chosen." },
        timeoutMs: { type: "integer", description: "Stops it after this many milliseconds." },
        transcript: { type: "boolean", default: false, description: "Also read the transcript." },
    },
    additionalProperties: false,
});

/** The plugin. */
export const harnessesPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "The harness entity, launching a harness, headless runs, and the tools settings.",
    dependsOn: {
        "@sous-io/plugin-build": "^0.2.34",
        "@sous-io/plugin-host": "^0.2.34",
    },

    register(sous) {
        sous.entities.define("harness", harnessSchema, {
            description: "A program that wraps a model, used interactively, headless, or both.",
        });

        sous.entities.add("config-key", {
            id: TOOLS_KEY,
            schema: toolsKeySchema,
            description: "Tools you can launch with `sous launch <name>`: command, args, promptFile, headless.",
        });

        sous.config.contribute(toolsContributor);

        sous.intents.add({
            intent: "launch",
            summary: "Build this project's outputs, then start a coding agent configured in its config",
            input: launchInput,
            requiresProject: true,
            cli: {
                positional: ["tool"],
                // Flags launch does not know go to the tool, after the config's own args.
                passThrough: true,
                examples: [
                    "sous launch claude",
                    "sous launch codex --no-build",
                    "sous launch claude --continuous",
                    "sous launch claude -- -c",
                ],
            },
            load: () => import("./launch.js"),
        });

        sous.intents.add({
            intent: "harness.run-headless",
            summary: "Run a coding agent with no person at the keyboard, and read its transcript",
            input: runHeadlessInput,
            cli: { command: ["harness", "run-headless"], hidden: true },
            load: () => import("./run-headless.js"),
        });
    },
});

export default harnessesPlugin;

export { TOOLS_CONTRIBUTOR } from "./contributor.js";
export { launchArguments, toolHarness } from "./tool.js";
export type * from "./types.js";
