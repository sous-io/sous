/**
 * plugin-github: A repository-host entity for GitHub: reading indexes, the token, proposing changes, the CI workflow.
 *
 * S6, "Host and package-manager plugins". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-github";

/** The plugin. */
export const githubPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "A repository-host entity for GitHub: reading indexes, the token, proposing changes, the CI workflow.",
    dependsOn: {
        "@sous-io/plugin-recipes": "^0.2.34",
        "@sous-io/plugin-host": "^0.2.34",
        "@sous-io/plugin-git": "^0.2.34",
    },

    register(sous) {
        // TODO(plugin-github): a stub until the plugin is written. It must register:
        //   - entity: repository-host `github` (read strategies, token sources, pull requests, the GitHub Actions workflow)
        void sous;
    },
});

export default githubPlugin;

export type * from "./types.js";
