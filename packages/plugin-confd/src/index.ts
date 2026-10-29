/**
 * plugin-confd: The conf.d files, one contributor per file, and surgical edits to the managed conf.d/5xx files.
 *
 * S6, "Config files: plugin-config-files and plugin-confd". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-confd";

/** The plugin. */
export const confdPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "The conf.d files, one contributor per file, and surgical edits to the managed conf.d/5xx files.",
    dependsOn: {
        "@sous-io/plugin-config-files": "^0.2.34",
        "@sous-io/plugin-expressions": "^0.2.34",
        "@sous-io/plugin-variables": "^0.2.34",
        "@sous-io/plugin-host": "^0.2.34",
    },

    register(sous) {
        // TODO(plugin-confd): a stub until the plugin is written. It must register:
        //   - contributors: one per conf.d file, `confd/<file name>`, each after the one before, the first after config-files.main
        //   - services: confd.files (config), confd.managed (config)
        void sous;
    },
});

export default confdPlugin;

export type * from "./types.js";
