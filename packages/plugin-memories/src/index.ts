/**
 * plugin-memories: Memories: selecting them, the memory-target entity, the compilation targets for them, the #memories name.
 *
 * S6, "Memories: plugin-memories". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-memories";

/** The plugin. */
export const memoriesPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "Memories: selecting them, the memory-target entity, the compilation targets for them, the #memories name.",
    dependsOn: {
        "@sous-io/plugin-compiler": "^0.2.34",
        "@sous-io/plugin-recipes": "^0.2.34",
        "@sous-io/plugin-refs": "^0.2.34",
        "@sous-io/plugin-host": "^0.2.34",
    },

    register(sous) {
        // TODO(plugin-memories): a stub until the plugin is written. It must register:
        //   - entity kind: memory-target (define)
        //   - contributor: memories.targets (a compilation target per memory target; a pointer-file entity per target read in any directory)
        //   - service: memories.selection (config)
        //   - entity: hash-name `memories` (a view)
        //   - config-key entity: recipes.memories
        void sous;
    },
});

export default memoriesPlugin;

export type * from "./types.js";
