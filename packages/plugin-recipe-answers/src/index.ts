/**
 * plugin-recipe-answers: recipe variable definitions, the answer ladder, asking for answers,
 * answer files and variable mappings.
 *
 * The contract other plugins code against is
 * `./types.ts`.
 */

import { definePlugin, jsonSchema, type PluginDefinition } from "@sous-io/plugin-api";
import { AnswersService, computeAnswers } from "./answers.js";
import { DefinitionsService } from "./definitions.js";
import { varsIntents } from "./intents.js";
import { envVarLookup, variableLookup } from "./lookups.js";
import { MappingsService } from "./mappings.js";
import { PreanswersService } from "./preanswers.js";
import { buildLadder } from "./sources.js";
import "./types.js";
import { validator } from "./validate.js";
import { variableSourceContributor } from "./variable-source.js";

/** The plugin's name. */
export const PLUGIN_NAME = "@sous-io/plugin-recipe-answers";

/** The plugin. */
export const recipeAnswersPlugin: PluginDefinition = definePlugin({
    name: PLUGIN_NAME,
    version: "0.2.34",
    description: "Recipe variable definitions, the answer ladder, asking for answers, answer files and variable mappings.",
    dependsOn: {
        "@sous-io/plugin-recipes": "^0.2.34",
        "@sous-io/plugin-confd": "^0.2.34",
        "@sous-io/plugin-config-files": "^0.2.34",
        "@sous-io/plugin-formats": "^0.2.34",
        "@sous-io/plugin-refs": "^0.2.34",
        "@sous-io/plugin-variables": "^0.2.34",
    },

    register(sous) {
        sous.services.add("recipe-answers.definitions", (_config, ctx) => new DefinitionsService(ctx), { lifetime: "config" });
        sous.services.add("recipe-answers.ladder", (config, ctx) => buildLadder({ services: ctx.services, env: ctx.env, config }), { lifetime: "config" });
        sous.services.add(
            "recipe-answers.answers",
            (_config, ctx) =>
                new AnswersService(() => computeAnswers(ctx.services.get("recipe-answers.definitions").listSync(), ctx.services.get("recipe-answers.ladder"))),
            { lifetime: "config" },
        );
        sous.services.add("recipe-answers.preanswers", (_config, ctx) => new PreanswersService(ctx), { lifetime: "factory" });
        sous.services.add("recipe-answers.mappings", (_config, ctx) => new MappingsService(ctx), { lifetime: "config" });
        sous.services.add("recipe-answers.validator", () => validator, { lifetime: "singleton" });

        sous.entities.add("config-key", {
            id: "varMappings",
            description: "Environment variable names bound to recipe variables (conf.d/520-var-mappings.jsonc).",
            schema: jsonSchema<Record<string, string>>({ type: "object", additionalProperties: { type: "string" }, default: {} }),
        });

        sous.entities.add("ref-lookup", variableLookup);
        sous.entities.add("ref-lookup", envVarLookup);

        sous.config.contribute(variableSourceContributor(sous.services));

        for (const intent of varsIntents) {
            sous.intents.add(intent);
        }
    },
});

export default recipeAnswersPlugin;

export { answersForRecipe, computeAnswers, unansweredWarning } from "./answers.js";
export { askLeadIn, askSummary, recipeOpeningLine } from "./ask.js";
export { definitionsFromRecipes, recipeKey, variableKey, variableRefOf } from "./definitions.js";
export { describeSource, RUNG_LABELS, SOURCE_LABELS } from "./ladder.js";
export { formatMappingTarget, parseMappingTarget } from "./mappings.js";
export { constraintBullets, constraintHints, validateAnswer } from "./validate.js";
export type * from "./types.js";
