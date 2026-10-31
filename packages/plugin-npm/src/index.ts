/**
 * plugin-npm: A package-manager entity for npm.
 *
 * The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import { npmManager } from "./manager.js";
import "./types.js";
import packageJson from "../package.json" with { type: "json" };

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-npm";

/** The plugin. */
export const npmPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: packageJson.version,
    description: "A package-manager entity for npm.",
    dependsOn: {
        "@sous-io/plugin-update": `^${packageJson.version}`,
        "@sous-io/plugin-host": `^${packageJson.version}`,
    },

    register(sous) {
        sous.entities.add("package-manager", npmManager);
    },
});

export default npmPlugin;

export { npmManager } from "./manager.js";
export type * from "./types.js";
