/**
 * plugin-recipes: Repositories, trust, subscriptions, the lockfile, the store, the index cache, links, the core recipe, the catalog and recipe plugins.
 *
 * S6, "Recipes: plugin-recipes". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
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

    register(sous) {
        // TODO(plugin-recipes): a stub until the plugin is written. It must register:
        //   - entity kinds: repository-host, active-recipe (define)
        //   - contributors: recipes.core, recipes.fetch (adds active-recipe entities), recipes.config-layers, recipes.plugins
        //   - services: recipes.trust, recipes.active, recipes.resolver, recipes.lock (config); recipes.store, recipes.index-cache, recipes.declarations (singleton); recipes.links (config); compiler.namespace-resolver (config, the implementation)
        //   - ref-lookup entities: cached index, fetched index, lockfile, recorded dependencies
        //   - intents: repo.add, repo.remove, repo.trust, repo.list, repo.search, repo.gc, repo.link, repo.unlink, subscription.add/remove/enable/disable/list/update, recipe.update, lock.rebuild, lock.show, namespace.list, namespace.show, recipe.list, recipe.show
        //   - events: recipes.fetched, recipes.locked
        //   - config-key entities: repos, subscriptions, store
        void sous;
    },
});

export default recipesPlugin;

export type * from "./types.js";
