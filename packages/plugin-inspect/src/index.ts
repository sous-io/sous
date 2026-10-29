/**
 * plugin-inspect: Showing the engine's state: config show, config get, config validate, plugins show, timings.
 *
 * S6, "Showing the engine's state: plugin-inspect". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-inspect";

/** The plugin. */
export const inspectPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "Showing the engine's state: config show, config get, config validate, plugins show, timings.",
    dependsOn: {},

    register(sous) {
        // TODO(plugin-inspect): a stub until the plugin is written. It must register:
        //   - intents: config.show, config.get, config.validate, plugins.show, timings.show
        void sous;
    },
});

export default inspectPlugin;

export type * from "./types.js";
