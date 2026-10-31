/**
 * plugin-claude-code: Everything sous knows about Claude Code: its harness, skill-target and memory-target entities.
 *
 * The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-host/types";
import { claudeHarness } from "./harness.js";
import { targetsContributor } from "./targets.js";
import "./types.js";
import packageJson from "../package.json" with { type: "json" };

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-claude-code";

/** The plugin. */
export const claudeCodePlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: packageJson.version,
    description: "Everything sous knows about Claude Code: its harness, skill-target and memory-target entities.",
    dependsOn: {
        "@sous-io/plugin-skills": `^${packageJson.version}`,
        "@sous-io/plugin-memories": `^${packageJson.version}`,
        "@sous-io/plugin-harnesses": `^${packageJson.version}`,
        "@sous-io/plugin-host": `^${packageJson.version}`,
    },

    register(sous) {
        sous.entities.add("harness", claudeHarness);
        sous.config.contribute(targetsContributor);
    },
});

export default claudeCodePlugin;

export type * from "./types.js";

export { claudeHarness } from "./harness.js";
export { contributeTargets, SKILLS_DIRECTORY, MEMORY_FILE } from "./targets.js";
export { finalText, parseStream, transcriptEntries } from "./transcript.js";
