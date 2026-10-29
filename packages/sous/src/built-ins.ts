import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import { cliPlugin } from "@sous-io/plugin-cli";

/**
 * Loads the plugins named in `SOUS_PLUGINS` (separated by commas), for one run, by adding them to
 * `plugins.load`. A stopgap until `plugin-config-files` owns the `SOUS_*` variables; a project's
 * files can list plugins the same way.
 */
export const envPluginsPlugin: PluginDefinition = definePlugin({
    name: "@sous-io/sous",
    version: "0.2.34",
    description: "Loads the plugins named in SOUS_PLUGINS.",

    register(sous) {
        sous.config.contribute({
            id: "sous/env-plugins",
            contribute(config) {
                const listed = (config.env.SOUS_PLUGINS ?? "")
                    .split(",")
                    .map((item) => item.trim())
                    .filter((item) => item !== "");

                for (const specifier of listed) {
                    config.atPath("plugins.load").append(specifier);
                }
            },
        });
    },
});

/**
 * The built-in plugins, loaded first and in this order unless the config disables them (S1,
 * "Built-in Plugins"; S6 lists the full set, which later waves add here).
 */
export const BUILT_IN_PLUGINS: readonly PluginDefinition[] = [cliPlugin, envPluginsPlugin];
