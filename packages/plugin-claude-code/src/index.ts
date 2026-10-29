/**
 * plugin-claude-code: Everything sous knows about Claude Code: its harness, skill-target and memory-target entities.
 *
 * S6, "Host and package-manager plugins (plugin-claude-code)". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-claude-code";

/** The plugin. */
export const claudeCodePlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "Everything sous knows about Claude Code: its harness, skill-target and memory-target entities.",
    dependsOn: {
        "@sous-io/plugin-skills": "^0.2.34",
        "@sous-io/plugin-memories": "^0.2.34",
        "@sous-io/plugin-harnesses": "^0.2.34",
        "@sous-io/plugin-host": "^0.2.34",
    },

    register(sous) {
        // TODO(plugin-claude-code): a stub until the plugin is written. It must register:
        //   - entities: harness `claude`, skill-target `claude-code` (.claude/skills), memory-target `claude-code` (CLAUDE.md, any-directory)
        void sous;
    },
});

export default claudeCodePlugin;

export type * from "./types.js";
