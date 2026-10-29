/**
 * plugin-host: The machine sous runs on: processes, HTTP, globs and paths, sous home, self-describing directories, the .gitignore block, package identity.
 *
 * S6, "The machine: plugin-host". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-host";

/** The plugin. */
export const hostPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "The machine sous runs on: processes, HTTP, globs and paths, sous home, self-describing directories, the .gitignore block, package identity.",
    dependsOn: {},

    register(sous) {
        // TODO(plugin-host): a stub until the plugin is written. It must register:
        //   - services: host.processes, host.http, host.globs, host.sous-home, host.gitignore, host.package (singleton); host.directories (config: it reads the pointer-file entities)
        //   - entity kind: pointer-file (define)
        void sous;
    },
});

export default hostPlugin;

export type * from "./types.js";
