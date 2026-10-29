/**
 * plugin-yarn: A package-manager entity for Yarn, and Yarn Plug'n'Play's plugin locator.
 *
 * S6, "Host and package-manager plugins". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-yarn";

/** The plugin. */
export const yarnPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "A package-manager entity for Yarn, and Yarn Plug'n'Play's plugin locator.",
    dependsOn: {
        "@sous-io/plugin-update": "^0.2.34",
        "@sous-io/plugin-host": "^0.2.34",
    },

    register(sous) {
        // TODO(plugin-yarn): a stub until the plugin is written. It must register:
        //   - entities: package-manager `yarn`, plugin-locator `yarn-pnp`
        void sous;
    },
});

export default yarnPlugin;

export type * from "./types.js";
