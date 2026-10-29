/**
 * plugin-update: Updating sous itself, installing plugins a recipe requires, the package-manager entity, scanning for installed plugins.
 *
 * S6, "Project setup and updates: plugin-init, plugin-update". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-update";

/** The plugin. */
export const updatePlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "Updating sous itself, installing plugins a recipe requires, the package-manager entity, scanning for installed plugins.",
    dependsOn: {
        "@sous-io/plugin-host": "^0.2.34",
    },

    register(sous) {
        // TODO(plugin-update): a stub until the plugin is written. It must register:
        //   - entity kind: package-manager (define)
        //   - contributor: update.scan (adds installed plugins to plugins.load when plugins.discover is scan)
        //   - intents: update, plugins.install
        void sous;
    },
});

export default updatePlugin;

export type * from "./types.js";
