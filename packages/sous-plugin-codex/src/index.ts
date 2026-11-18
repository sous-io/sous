/**
 * sous-plugin-codex: Everything sous knows about Codex: its harness, its memories file
 * (`AGENTS.override.md`) and its skills folder. Off until a project turns it on.
 *
 * The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import type {} from "@sous-io/plugin-host/types";
import { targetsContributor } from "./targets.js";
import "./types.js";
import packageJson from "../package.json" with { type: "json" };

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/sous-plugin-codex";

/** The plugin. */
export const codexPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: packageJson.version,
    description: "Everything sous knows about Codex: its harness, its memories file (AGENTS.override.md) and its skills folder. Off until a project turns it on.",
    dependsOn: {
        "@sous-io/plugin-skills": `^${packageJson.version}`,
        "@sous-io/plugin-memories": `^${packageJson.version}`,
        "@sous-io/plugin-harnesses": `^${packageJson.version}`,
        "@sous-io/plugin-host": `^${packageJson.version}`,
    },

    register(sous) {
        sous.config.contribute(targetsContributor);
    },
});

export default codexPlugin;

export type * from "./types.js";

export { codexHarness, DEFAULT_COMMAND, HARNESS_ID } from "./harness.js";
export {
    configPath,
    contributeTargets,
    DEFAULT_MEMORIES_OUTPUT_PATH,
    DEFAULT_PREPEND_MEMORIES_WITH,
    ignoreLine,
    isCodexOn,
    MEMORY_FILE,
    SKILLS_DIRECTORY,
} from "./targets.js";
