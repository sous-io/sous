/**
 * plugin-inspect: Showing the engine's state: config show, config get, config validate, plugins show, timings.
 *
 * S6, "Showing the engine's state: plugin-inspect". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import { configGet, configShow, configValidate, pluginsShow, timingsShow } from "./handlers.js";
import { configGetSchema, configShowSchema, pluginsShowSchema, timingsShowSchema } from "./schemas.js";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-inspect";

/** The plugin. */
export const inspectPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "Showing the engine's state: config show, config get, config validate, plugins show, timings.",
    dependsOn: {},

    register(sous) {
        sous.intents.add({
            intent: "config.show",
            summary: "Print the built config",
            description: "Prints what sous does on this machine. --layers adds each contributor's changes, in order; --raw adds each config file as written.",
            input: configShowSchema,
            parallel: true,
            cli: { examples: ["sous config show", "sous config show --layers", "sous config show --raw"] },
            agent: { usage: "Read the config as sous built it. Secrets are hidden." },
            handle: configShow,
        });

        sous.intents.add({
            intent: "config.get",
            summary: "Print one value from the built config by path",
            description: "A path like compilation.targets[0].entryPoint. --layers shows who set the value, in order.",
            input: configGetSchema,
            parallel: true,
            cli: {
                positional: ["path"],
                examples: ["sous config get name", "sous config get compilation.targets[0].entryPoint", "sous config get compilation --layers"],
            },
            agent: { usage: "Read one config value by path. Secrets are hidden." },
            handle: configGet,
        });

        sous.intents.add({
            intent: "config.validate",
            summary: "Check the built config against every config key's schema",
            parallel: true,
            cli: { examples: ["sous config validate"] },
            handle: configValidate,
        });

        sous.intents.add({
            intent: "plugins.show",
            summary: "Show every plugin, and what it registered, wrapped or replaced",
            input: pluginsShowSchema,
            parallel: true,
            cli: { positional: ["name"], examples: ["sous plugins show", "sous plugins show @sous-io/plugin-git"] },
            handle: pluginsShow,
        });

        sous.intents.add({
            intent: "timings.show",
            summary: "Show every timing of this run and its budget",
            input: timingsShowSchema,
            parallel: true,
            cli: { examples: ["sous timings show", "sous timings show --over-budget"] },
            handle: timingsShow,
        });
    },
});

export default inspectPlugin;

export type * from "./types.js";
