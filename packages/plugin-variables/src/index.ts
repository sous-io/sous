/**
 * plugin-variables: ${var} substitution, _vars resolution, auto-variables, variable names and secrets.
 *
 * S6, "Shared building blocks (variables.*, variable-source)". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-variables";

/** The plugin. */
export const variablesPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "${var} substitution, _vars resolution, auto-variables, variable names and secrets.",
    dependsOn: {
        "@sous-io/plugin-host": "^0.2.34",
    },

    register(sous) {
        // TODO(plugin-variables): a stub until the plugin is written. It must register:
        //   - services: variables.resolver (config), variables.names (singleton), variables.secrets (config)
        //   - entity kind: variable-source (define)
        //   - config-key entities: _vars, _env (refuse auto-variable names in _vars)
        void sous;
    },
});

export default variablesPlugin;

export type * from "./types.js";
