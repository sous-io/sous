/**
 * plugin-local: A repository-host entity for a repository on disk.
 *
 * The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import { createLocalHost } from "./host.js";
import "./types.js";
import packageJson from "../package.json" with { type: "json" };

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-local";

/** The plugin. */
export const localPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: packageJson.version,
    description: "A repository-host entity for a repository on disk.",
    dependsOn: {
        "@sous-io/plugin-recipes": `^${packageJson.version}`,
        "@sous-io/plugin-host": `^${packageJson.version}`,
        "@sous-io/plugin-git": `^${packageJson.version}`,
        "@sous-io/plugin-formats": `^${packageJson.version}`,
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
