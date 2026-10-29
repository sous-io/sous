/**
 * plugin-recipe-answers: Recipe variable definitions, the answer ladder, asking for answers, answer files and variable mappings.
 *
 * S6, "Recipe answers: plugin-recipe-answers". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-recipe-answers";

/** The plugin. */
export const recipeAnswersPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "Recipe variable definitions, the answer ladder, asking for answers, answer files and variable mappings.",
    dependsOn: {
        "@sous-io/plugin-recipes": "^0.2.34",
        "@sous-io/plugin-confd": "^0.2.34",
        "@sous-io/plugin-config-files": "^0.2.34",
        "@sous-io/plugin-formats": "^0.2.34",
        "@sous-io/plugin-refs": "^0.2.34",
        "@sous-io/plugin-variables": "^0.2.34",
    },

    register(sous) {
        // TODO(plugin-recipe-answers): a stub until the plugin is written. It must register:
        //   - services: recipe-answers.definitions, .ladder, .answers, .mappings (config); .preanswers (factory); .validator (singleton)
        //   - entity: variable-source `recipe-answers` (forbiddenUnder: subscriptions, repos)
        //   - ref-lookup entities: variables, environment variable names
        //   - intents: vars.ask, vars.list, vars.show, vars.map
        //   - config-key entity: varMappings
        void sous;
    },
});

export default recipeAnswersPlugin;

export type * from "./types.js";
