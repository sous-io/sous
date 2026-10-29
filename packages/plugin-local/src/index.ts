/**
 * plugin-local: A repository-host entity for a repository on disk.
 *
 * S6, "Host and package-manager plugins". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-local";

/** The plugin. */
export const localPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "A repository-host entity for a repository on disk.",
    dependsOn: {
        "@sous-io/plugin-recipes": "^0.2.34",
        "@sous-io/plugin-host": "^0.2.34",
        "@sous-io/plugin-git": "^0.2.34",
    },

    register(sous) {
        // TODO(plugin-local): a stub until the plugin is written. It must register:
        //   - entity: repository-host `local`
        void sous;
    },
});

export default localPlugin;

export type * from "./types.js";
