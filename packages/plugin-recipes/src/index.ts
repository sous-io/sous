/**
 * plugin-recipes: Repositories, trust, subscriptions, the lockfile, the store, the index cache, links, the core recipe, the catalog and recipe plugins.
 *
 * The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import { defineEntityKinds, registerPartA } from "./part-a/index.js";
import { registerPartB } from "./part-b/index.js";
import "./types.js";
import packageJson from "../package.json" with { type: "json" };

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-recipes";

/** The plugin. */
export const recipesPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: packageJson.version,
    description: "Repositories, trust, subscriptions, the lockfile, the store, the index cache, links, the core recipe, the catalog and recipe plugins.",
    dependsOn: {
        "@sous-io/plugin-confd": `^${packageJson.version}`,
        "@sous-io/plugin-formats": `^${packageJson.version}`,
        "@sous-io/plugin-refs": `^${packageJson.version}`,
        "@sous-io/plugin-variables": `^${packageJson.version}`,
        "@sous-io/plugin-git": `^${packageJson.version}`,
        "@sous-io/plugin-compiler": `^${packageJson.version}`,
        "@sous-io/plugin-host": `^${packageJson.version}`,
    },

    async register(sous) {
        // Part B first, so the entity kinds it defines win; part A defines any it left out.
        await registerPartB(sous);
        defineEntityKinds(sous);
        registerPartA(sous);
    },
});

export default recipesPlugin;

export type * from "./types.js";
