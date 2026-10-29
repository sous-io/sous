/**
 * plugin-build: The build, compile, prune and clear intents, preparing for a build, watch mode, the PID file, the runtime context file.
 *
 * S6, "Build: plugin-build". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-build";

/** The plugin. */
export const buildPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "The build, compile, prune and clear intents, preparing for a build, watch mode, the PID file, the runtime context file.",
    dependsOn: {
        "@sous-io/plugin-compiler": "^0.2.34",
        "@sous-io/plugin-recipes": "^0.2.34",
        "@sous-io/plugin-recipe-answers": "^0.2.34",
        "@sous-io/plugin-git": "^0.2.34",
        "@sous-io/plugin-host": "^0.2.34",
    },

    register(sous) {
        // TODO(plugin-build): a stub until the plugin is written. It must register:
        //   - intents: build, compile, prune, clear; build.prepare (internal); build.watch (background)
        //   - services: build.pid (singleton), build.runtime-context (config)
        //   - events: build.prepared, build.files-changed
        //   - config-key entities: watch, runtimeContext
        void sous;
    },
});

export default buildPlugin;

export type * from "./types.js";
