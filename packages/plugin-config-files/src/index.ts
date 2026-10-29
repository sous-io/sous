/**
 * plugin-config-files: sous.config.* as a contributor, config.set, and the .env files.
 *
 * S6, "Config files: plugin-config-files and plugin-confd". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-config-files";

/** The plugin. */
export const configFilesPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "sous.config.* as a contributor, config.set, and the .env files.",
    dependsOn: {
        "@sous-io/plugin-expressions": "^0.2.34",
        "@sous-io/plugin-variables": "^0.2.34",
        "@sous-io/plugin-host": "^0.2.34",
    },

    register(sous) {
        // TODO(plugin-config-files): a stub until the plugin is written. It must register:
        //   - contributor: config-files.main (sous.config.* as one merge at the root; its patch files after it)
        //   - services: config-files.loader, config-files.env (singleton)
        //   - intent: config.set (changesConfig)
        //   - config-key entities: $schema, version, name
        void sous;
    },
});

export default configFilesPlugin;

export type * from "./types.js";
