/**
 * plugin-authoring: Releasing, submitting and contributing to recipe repositories, and scaffolding one.
 *
 * S6, "Authoring: plugin-authoring". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-authoring";

/** The plugin. */
export const authoringPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "Releasing, submitting and contributing to recipe repositories, and scaffolding one.",
    dependsOn: {
        "@sous-io/plugin-recipes": "^0.2.34",
        "@sous-io/plugin-formats": "^0.2.34",
        "@sous-io/plugin-refs": "^0.2.34",
        "@sous-io/plugin-variables": "^0.2.34",
        "@sous-io/plugin-git": "^0.2.34",
    },

    register(sous) {
        // TODO(plugin-authoring): a stub until the plugin is written. It must register:
        //   - intents: repo.release, repo.submit, repo.contribute (runs repo.link, repo.submit, repo.unlink), repo.init
        //   - events: authoring.released, authoring.submitted
        void sous;
    },
});

export default authoringPlugin;

export type * from "./types.js";
