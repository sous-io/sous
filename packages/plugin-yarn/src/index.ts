/**
 * plugin-yarn: A package-manager entity for Yarn, and Yarn Plug'n'Play's plugin locator.
 *
 * The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import { yarnManager } from "./manager.js";
import { yarnPnpLocator } from "./pnp.js";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-yarn";

/** The plugin. */
export const yarnPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "A package-manager entity for Yarn, and Yarn Plug'n'Play's plugin locator.",
    dependsOn: {
        "@sous-io/plugin-update": "^0.2.34",
        "@sous-io/plugin-host": "^0.2.34",
    },

    register(sous) {
        sous.entities.add("package-manager", yarnManager);
        sous.entities.add("plugin-locator", yarnPnpLocator);
    },
});

export default yarnPlugin;

export { isBerry, yarnManager } from "./manager.js";
export { PNP_FILE, yarnPnpLocator } from "./pnp.js";
export type * from "./types.js";
