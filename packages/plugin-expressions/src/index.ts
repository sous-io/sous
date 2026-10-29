/**
 * plugin-expressions: Config expressions (S5) and the expression languages plugins add.
 *
 * S6, "Shared building blocks (expressions.evaluator, expression-language)". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-expressions";

/** The plugin. */
export const expressionsPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "Config expressions (S5) and the expression languages plugins add.",
    dependsOn: {
        "@sous-io/plugin-liquid": "^0.2.34",
        "@sous-io/plugin-variables": "^0.2.34",
    },

    register(sous) {
        // TODO(plugin-expressions): a stub until the plugin is written. It must register:
        //   - service: expressions.evaluator (config)
        //   - entity kind: expression-language (define)
        //   - entity: expression-language `liquid` (evalValueSync; variables listed without running)
        //   - listener: config.built, turning unsettled() into a ConfigError naming each expression
        void sous;
    },
});

export default expressionsPlugin;

export type * from "./types.js";
