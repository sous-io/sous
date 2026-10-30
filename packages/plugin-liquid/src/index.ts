/**
 * plugin-liquid: A configured LiquidJS engine, and the Liquid tags and filters plugins add.
 *
 * The contract other plugins code against is `./types.ts`.
 * The built-in tags and filter (`showVars`, `exportScalarVarsJs`, `getFiles`, `listFiles`,
 * `bulletList`) are `liquid-tag` and `liquid-filter` entities plugin-compiler adds.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import { createLiquidEngines } from "./engine.js";
import { liquidFilterSchema, liquidTagSchema } from "./entity-schemas.js";
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
        sous.entities.define("liquid-tag", liquidTagSchema, { description: "A Liquid tag, as written in {% name %}." });
        sous.entities.define("liquid-filter", liquidFilterSchema, {
            description: "A Liquid filter, as written after |. Config expressions see it too.",
        });

        sous.services.add("liquid.engine", (_config, ctx) => createLiquidEngines(ctx), { lifetime: "factory" });
    },
});

export default liquidPlugin;

export { createLiquidEngines, filterAllowed, tagAllowed, CONFIG_EXPRESSION_PURPOSE, DEFAULT_PURPOSE } from "./engine.js";
export type { LiquidEngineDeps } from "./engine.js";
export type * from "./types.js";
