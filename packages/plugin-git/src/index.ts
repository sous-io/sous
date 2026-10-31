/**
 * plugin-git: The one git runner.
 *
 * The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import { createGitRunner } from "./runner.js";
import "./types.js";

// Brings in the `host.*` service declarations this plugin uses.
import "@sous-io/plugin-host/types";
import packageJson from "../package.json" with { type: "json" };

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-git";

/** The plugin. */
export const gitPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: packageJson.version,
    description: "The one git runner.",
    dependsOn: {
        "@sous-io/plugin-host": `^${packageJson.version}`,
    },

    register(sous) {
        sous.services.add("git.runner", (_config, ctx) => createGitRunner({ processes: ctx.services.get("host.processes"), env: ctx.env }), {
            lifetime: "singleton",
        });
    },
});

export default gitPlugin;

export type * from "./types.js";

export { GIT_TIMEOUT_EXIT_CODE, GitError } from "./errors.js";
export { createGitRunner, LF_CHECKOUT_OPTIONS } from "./runner.js";
