/**
 * plugin-github: A repository-host entity for GitHub: reading indexes, the token, proposing changes, the CI workflow.
 *
 * S6, "Host and package-manager plugins". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import { createGithubHost } from "./host.js";
import type { GithubPluginOptions } from "./types.js";

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
        // A contributor, not a fixed entity, because the options name more GitHub hosts.
        sous.config.contribute({
            id: "github/repository-host",
            before: ["@sous-io/plugin-recipes"],

            contribute(config) {
                config.addEntity("repository-host", createGithubHost(config.options<GithubPluginOptions>() ?? {}));
            },
        });
    },
});

export default githubPlugin;

export { buildReleaseWorkflow, GITHUB_WORKFLOW_PATH, githubWorkflowFiles } from "./ci.js";
export { GH } from "./gh.js";
export { createGithubHost, githubApiFileUrl, githubRawFileUrl, GITHUB_HOST, GITHUB_TOKEN_VARIABLES, readGithubLocation } from "./host.js";

export type * from "./types.js";
