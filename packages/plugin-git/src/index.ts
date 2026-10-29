/**
 * plugin-git: The one git runner.
 *
 * S6, "Shared building blocks (git.runner)". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-git";

/** The plugin. */
export const gitPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "The one git runner.",
    dependsOn: {
        "@sous-io/plugin-host": "^0.2.34",
    },

    register(sous) {
        // TODO(plugin-git): a stub until the plugin is written. It must register:
        //   - service: git.runner (singleton), running git through host.processes
        void sous;
    },
});

export default gitPlugin;

export type * from "./types.js";
