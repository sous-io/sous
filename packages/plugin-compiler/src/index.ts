/**
 * plugin-compiler: Compiling templates, includes, aliases, compilation settings, the built-in tags and filters, the state file, writing outputs, pruning.
 *
 * S6, "Compiler: plugin-compiler". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-compiler";

/** The plugin. */
export const compilerPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "Compiling templates, includes, aliases, compilation settings, the built-in tags and filters, the state file, writing outputs, pruning.",
    dependsOn: {
        "@sous-io/plugin-liquid": "^0.2.34",
        "@sous-io/plugin-refs": "^0.2.34",
        "@sous-io/plugin-variables": "^0.2.34",
        "@sous-io/plugin-host": "^0.2.34",
    },

    register(sous) {
        // TODO(plugin-compiler): a stub until the plugin is written. It must register:
        //   - services: compiler.includes, compiler.aliases, compiler.state, compiler.writer (config)
        //   - entity kind: compilation-transform (define)
        //   - liquid-tag entities: showVars, exportScalarVarsJs, getFiles, listFiles; liquid-filter entity: bulletList
        //   - intents (internal): compiler.compile, compiler.prune
        //   - events: compiler.wrote, compiler.pruned
        //   - config-key entities: compilation, _aliases
        void sous;
    },
});

export default compilerPlugin;

export type * from "./types.js";
