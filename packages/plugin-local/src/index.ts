/**
 * plugin-local: A repository-host entity for a repository on disk.
 *
 * S6, "Host and package-manager plugins". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import { createLocalHost } from "./host.js";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-local";

/** The plugin. */
export const localPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "A repository-host entity for a repository on disk.",
    dependsOn: {
        "@sous-io/plugin-recipes": "^0.2.34",
        "@sous-io/plugin-host": "^0.2.34",
        "@sous-io/plugin-git": "^0.2.34",
        "@sous-io/plugin-formats": "^0.2.34",
    },

    register(sous) {
        sous.entities.add("repository-host", createLocalHost());
    },
});

export default localPlugin;

export { createLocalHost, LOCAL_HOST } from "./host.js";
export { assertLocalRepoDirectory } from "./repo-directory.js";
export { expandHomePath, localRepoPath, looksLikeLocalPath, resolveRepoArgument } from "./paths.js";

export type * from "./types.js";
