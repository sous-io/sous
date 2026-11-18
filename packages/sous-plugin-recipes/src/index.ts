/**
 * sous-plugin-recipes: Repositories, trust, subscriptions, the lockfile, the store, the index cache, links, the core recipe, the catalog and recipe plugins.
 *
 * The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import { defineEntityKinds, registerPartA } from "./part-a/index.js";
import { registerPartB } from "./part-b/index.js";
import "./types.js";
import packageJson from "../package.json" with { type: "json" };

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/sous-plugin-recipes";

/** The plugin. */
export const recipesPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: packageJson.version,
    description: "Repositories, trust, subscriptions, the lockfile, the store, the index cache, links, the core recipe, the catalog and recipe plugins.",
    dependsOn: {
        "@sous-io/sous-plugin-confd": `^${packageJson.version}`,
        "@sous-io/sous-plugin-formats": `^${packageJson.version}`,
        "@sous-io/sous-plugin-refs": `^${packageJson.version}`,
        "@sous-io/sous-plugin-variables": `^${packageJson.version}`,
        "@sous-io/sous-plugin-git": `^${packageJson.version}`,
        "@sous-io/sous-plugin-compiler": `^${packageJson.version}`,
        "@sous-io/sous-plugin-host": `^${packageJson.version}`,
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
export { RecipeContents } from "./part-a/contents.js";
export { insideRecipe } from "./part-b/plugins/recipe-plugins.js";
export { plainContentsEntries } from "./part-b/config-layers/config-layers.js";
export { BUILT_IN_CONTENT_KINDS, CONTENT_KIND } from "./part-a/manifests.js";
