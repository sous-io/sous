/**
 * plugin-formats: One parser per on-disk format, reading manifests, and the recipe content hash.
 *
 * S6, "Shared building blocks (formats.*)". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-formats";

/** The plugin. */
export const formatsPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "One parser per on-disk format, reading manifests, and the recipe content hash.",
    dependsOn: {
        "@sous-io/plugin-refs": "^0.2.34",
    },

    register(sous) {
        // TODO(plugin-formats): a stub until the plugin is written. It must register:
        //   - services (singleton): formats.lockfile, formats.recipe-manifest, formats.repo-manifest, formats.index-file, formats.links-map, formats.store-entry, formats.variable-definition, formats.manifests, formats.recipe-hash
        void sous;
    },
});

export default formatsPlugin;

export type * from "./types.js";
