/**
 * plugin-skills: Skills: where they come from, the skill-target entity, and the compilation targets for them.
 *
 * The contract other plugins code against is `./types.ts`.
 */

import { definePlugin, type PluginDefinition } from "@sous-io/plugin-api";
import { skillWarnings } from "./nowhere.js";
import { ConfigSkillsSources } from "./service.js";
import { skillsConfigKey } from "./settings.js";
import { SKILL_TARGET, SKILL_TARGET_DESCRIPTION, skillTargetSchema } from "./skill-target.js";
import { contributeSkillTargets, TARGETS_CONTRIBUTOR } from "./targets.js";
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
        sous.entities.define(SKILL_TARGET, skillTargetSchema, { description: SKILL_TARGET_DESCRIPTION });
        sous.entities.add("config-key", skillsConfigKey);

        sous.services.add("skills.sources", (config, ctx) => new ConfigSkillsSources(config, ctx), { lifetime: "config" });

        sous.config.contribute({
            id: TARGETS_CONTRIBUTOR,
            // Only for speed: the active recipes are usually known by then, which saves a pass.
            after: ["@sous-io/plugin-recipes"],
            contribute: (config) => contributeSkillTargets(config, PLUGIN_NAME),
        });

        // Says why skills go nowhere, from the finished config the compile runs with.
        sous.on("compiler.compile.before", (_event, ctx) => {
            for (const warning of skillWarnings(ctx)) {
                ctx.reporter.warning(warning);
            }
        });
    },
});

export default skillsPlugin;

export { describeNowhere, skillWarnings } from "./nowhere.js";
export { outputDir, skillDestinations, transformIdFor } from "./destinations.js";
export { findSkills, staticBase } from "./sources.js";
export type * from "./types.js";
