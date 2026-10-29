/**
 * plugin-harnesses: The harness entity, launching a harness, headless runs, and the tools settings.
 *
 * S6, "Harnesses: plugin-harnesses". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-harnesses";

/** The plugin. */
export const harnessesPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "The harness entity, launching a harness, headless runs, and the tools settings.",
    dependsOn: {
        "@sous-io/plugin-build": "^0.2.34",
        "@sous-io/plugin-host": "^0.2.34",
    },

    register(sous) {
        // TODO(plugin-harnesses): a stub until the plugin is written. It must register:
        //   - entity kind: harness (define)
        //   - contributor: harnesses.tools (a harness entity per `tools` entry no plugin provides)
        //   - intents: launch, harness.run-headless
        //   - event: harnesses.launched
        //   - config-key entity: tools
        void sous;
    },
});

export default harnessesPlugin;

export type * from "./types.js";
