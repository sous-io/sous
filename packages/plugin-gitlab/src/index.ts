/**
 * plugin-gitlab: A repository-host entity for GitLab, with S4's fixes to the index address and the token.
 *
 * S6, "Host and package-manager plugins". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

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
        // TODO(plugin-gitlab): a stub until the plugin is written. It must register:
        //   - entity: repository-host `gitlab` (S4's API address and glab token)
        void sous;
    },
});

export default gitlabPlugin;

export type * from "./types.js";
