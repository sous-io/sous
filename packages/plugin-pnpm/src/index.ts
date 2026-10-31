/**
 * plugin-pnpm: A package-manager entity for pnpm.
 *
 * The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import { pnpmManager } from "./manager.js";
import "./types.js";
import packageJson from "../package.json" with { type: "json" };

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-pnpm";

/** The plugin. */
export const pnpmPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: packageJson.version,
    description: "A package-manager entity for pnpm.",
    dependsOn: {
        "@sous-io/plugin-update": `^${packageJson.version}`,
        "@sous-io/plugin-host": `^${packageJson.version}`,
    },

    register(sous) {
        sous.entities.add("package-manager", pnpmManager);
    },
});

export default pnpmPlugin;

export { pnpmManager } from "./manager.js";
export type * from "./types.js";
