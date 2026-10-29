/**
 * plugin-gitlab: A repository-host entity for GitLab, with S4's fixes to the index address and the token.
 *
 * S6, "Host and package-manager plugins". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import { createGitlabHost } from "./host.js";
import type { GitlabPluginOptions } from "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-gitlab";

/** The plugin. */
export const gitlabPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "A repository-host entity for GitLab, with S4's fixes to the index address and the token.",
    dependsOn: {
        "@sous-io/plugin-recipes": "^0.2.34",
        "@sous-io/plugin-host": "^0.2.34",
        "@sous-io/plugin-git": "^0.2.34",
    },

    register(sous) {
        // A contributor, not a fixed entity, because the options name more GitLab hosts.
        sous.config.contribute({
            id: "gitlab/repository-host",
            before: ["@sous-io/plugin-recipes"],

            contribute(config) {
                config.addEntity("repository-host", createGitlabHost(config.options<GitlabPluginOptions>() ?? {}));
            },
        });
    },
});

export default gitlabPlugin;

export { buildGitlabPipeline, gitlabCiFiles, GITLAB_CI_PATH } from "./ci.js";
export { GLAB } from "./glab.js";
export { createGitlabHost, gitlabFileUrl, GITLAB_HOST, GITLAB_TOKEN_VARIABLES, readGitlabLocation } from "./host.js";

export type * from "./types.js";
