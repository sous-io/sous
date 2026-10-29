/**
 * plugin-skills: Skills: where they come from, the skill-target entity, and the compilation targets for them.
 *
 * S6, "Skills: plugin-skills". The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import "./types.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-skills";

/** The plugin. */
export const skillsPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "Skills: where they come from, the skill-target entity, and the compilation targets for them.",
    dependsOn: {
        "@sous-io/plugin-compiler": "^0.2.34",
        "@sous-io/plugin-recipes": "^0.2.34",
    },

    register(sous) {
        // TODO(plugin-skills): a stub until the plugin is written. It must register:
        //   - entity kind: skill-target (define)
        //   - contributor: skills.targets (compilation targets for every skill target and recipes.skills.outputs; a compilation-transform entity per target transform; says why when skills go nowhere)
        //   - service: skills.sources (config)
        //   - config-key entity: recipes.skills
        void sous;
    },
});

export default skillsPlugin;

export type * from "./types.js";
