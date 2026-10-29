/**
 * plugin-init: Scaffolding a project's .sous/ (sous init).
 *
 * S6, "Project setup and updates: plugin-init, plugin-update". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-init";

/** The plugin. */
export const initPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "Scaffolding a project's .sous/ (sous init).",
    dependsOn: {
        "@sous-io/plugin-build": "^0.2.34",
        "@sous-io/plugin-config-files": "^0.2.34",
        "@sous-io/plugin-host": "^0.2.34",
    },

    register(sous) {
        // TODO(plugin-init): a stub until the plugin is written. It must register:
        //   - intent: init (runs build through ctx.run unless noBuild)
        void sous;
    },
});

export default initPlugin;

export type * from "./types.js";
