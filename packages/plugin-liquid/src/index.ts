/**
 * plugin-liquid: A configured LiquidJS engine, and the Liquid tags and filters plugins add.
 *
 * S6, "Shared building blocks (liquid.engine, liquid-tag, liquid-filter)". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-liquid";

/** The plugin. */
export const liquidPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "A configured LiquidJS engine, and the Liquid tags and filters plugins add.",
    dependsOn: {
        "@sous-io/plugin-host": "^0.2.34",
    },

    register(sous) {
        // TODO(plugin-liquid): a stub until the plugin is written. It must register:
        //   - service: liquid.engine (factory)
        //   - entity kinds: liquid-tag, liquid-filter (define)
        void sous;
    },
});

export default liquidPlugin;

export type * from "./types.js";
