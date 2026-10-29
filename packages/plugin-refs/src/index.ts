/**
 * plugin-refs: Parsing and resolving refs, picking among matches, # names, repository locations and identity.
 *
 * S6, "Shared building blocks (refs.*, hash-name)". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-refs";

/** The plugin. */
export const refsPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "Parsing and resolving refs, picking among matches, # names, repository locations and identity.",
    dependsOn: {
        "@sous-io/plugin-host": "^0.2.34",
    },

    register(sous) {
        // TODO(plugin-refs): a stub until the plugin is written. It must register:
        //   - services: refs.parser, refs.resolver, refs.picker, refs.format, refs.locations (singleton; resolver and locations read entities, so config if they cache)
        //   - entity kinds: ref-splitter, ref-pruner, ref-lookup, hash-name (define)
        //   - entities: the built-in splitters (query, range, location, repo qualifier, env var, name/path) and pruners (commandLine, config, manifest, lockfile, include); hash-name `project`
        void sous;
    },
});

export default refsPlugin;

export type * from "./types.js";
