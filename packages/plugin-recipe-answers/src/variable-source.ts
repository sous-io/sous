/**
 * Recipe answers as config variables: the `variable-source` entity (id `recipe-answers`), so
 * config expressions and templates read them without plugin-variables knowing recipes exist (S2,
 * "Variable scopes", "Recipe answers").
 *
 * The entity is added by a contributor, since which recipes are active is known only while the
 * config is built (`active-recipe` entities); reading them re-runs the contributor whenever they
 * change. Its methods read the `varMappings` key and the env files each time they are called, so
 * they always see the config they are asked about.
 *
 * No expression under `subscriptions` or `repos` may read an answer: which recipes are pinned
 * depends on the subscriptions, so an answer could switch off the recipe that asked for it.
 */

import type { ContributorDefinition, ServiceReader } from "@sous-io/plugin-api";
import type { VariableSourceContext, VariableSourceEntity, VarScope } from "@sous-io/plugin-variables/types";
import { answersForRecipe, computeAnswers } from "./answers.js";
import { definitionsFromRecipes } from "./definitions.js";
import { buildLadder } from "./sources.js";
import type { DefinedVariable, RecipeAnswers } from "./types.js";

/** The entity's id. */
export const VARIABLE_SOURCE_ID = "recipe-answers";

/** The top-level keys under which no expression may read an answer. */
export const FORBIDDEN_UNDER = ["subscriptions", "repos"] as const;

/**
 * The `variable-source` entity over a fixed list of definitions.
 *
 * @param variables - The variables the active recipes define.
 * @param services - The engine's services; only singletons are used, so this works while building.
 */
export function recipeAnswersSource(variables: readonly DefinedVariable[], services: Pick<ServiceReader, "get" | "has">): VariableSourceEntity {
    const answers = (ctx: VariableSourceContext): RecipeAnswers => computeAnswers(variables, buildLadder({ services, env: ctx.env, config: ctx.config }));

    return {
        id: VARIABLE_SOURCE_ID,
        description: "recipe answers",
        variables: (ctx): VarScope => (variables.length === 0 ? {} : answers(ctx).merged),
        scoped: (scopeKey, ctx): VarScope | undefined => {
            if (!variables.some((entry) => `${entry.recipe.namespace}/${entry.recipe.name}` === scopeKey)) {
                return undefined;
            }

            return answersForRecipe(answers(ctx), scopeKey);
        },
        secrets: () => variables.filter((entry) => entry.definition.secret).map((entry) => entry.definition.name),
        forbiddenUnder: FORBIDDEN_UNDER,
    };
}

/**
 * The contributor that adds the entity, once per build, from the `active-recipe` entities. It runs
 * after plugin-recipes, whose `recipes.fetch` adds them, to save passes.
 */
export function variableSourceContributor(services: Pick<ServiceReader, "get" | "has">): ContributorDefinition {
    return {
        id: "recipe-answers.variable-source",
        after: ["@sous-io/plugin-recipes"],
        contribute(config) {
            const variables = definitionsFromRecipes(config.entities("active-recipe"));

            config.addEntity("variable-source", recipeAnswersSource(variables, services));
        },
    };
}
