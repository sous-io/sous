/**
 * plugin-npm: A package-manager entity for npm.
 *
 * S6, "Host and package-manager plugins". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import { npmManager } from "./manager.js";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-npm";

/** The plugin. */
export const npmPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "A package-manager entity for npm.",
    dependsOn: {
        "@sous-io/plugin-update": "^0.2.34",
        "@sous-io/plugin-host": "^0.2.34",
    },

    register(sous) {
        sous.entities.add("package-manager", npmManager);
    },
});

export default npmPlugin;

export { npmManager } from "./manager.js";
export type * from "./types.js";
