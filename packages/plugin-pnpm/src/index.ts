/**
 * plugin-pnpm: A package-manager entity for pnpm.
 *
 * S6, "Host and package-manager plugins". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import { pnpmManager } from "./manager.js";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-pnpm";

/** The plugin. */
export const pnpmPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "A package-manager entity for pnpm.",
    dependsOn: {
        "@sous-io/plugin-update": "^0.2.34",
        "@sous-io/plugin-host": "^0.2.34",
    },

    register(sous) {
        sous.entities.add("package-manager", pnpmManager);
    },
});

export default pnpmPlugin;

export { pnpmManager } from "./manager.js";
export type * from "./types.js";
