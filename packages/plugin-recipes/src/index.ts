/**
 * plugin-recipes: Repositories, trust, subscriptions, the lockfile, the store, the index cache, links, the core recipe, the catalog and recipe plugins.
 *
 * The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import { defineEntityKinds, registerPartA } from "./part-a/index.js";
import { registerPartB } from "./part-b/index.js";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-recipes";

/** The plugin. */
export const recipesPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "Repositories, trust, subscriptions, the lockfile, the store, the index cache, links, the core recipe, the catalog and recipe plugins.",
    dependsOn: {
        "@sous-io/plugin-confd": "^0.2.34",
        "@sous-io/plugin-formats": "^0.2.34",
        "@sous-io/plugin-refs": "^0.2.34",
        "@sous-io/plugin-variables": "^0.2.34",
        "@sous-io/plugin-git": "^0.2.34",
        "@sous-io/plugin-compiler": "^0.2.34",
        "@sous-io/plugin-host": "^0.2.34",
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
