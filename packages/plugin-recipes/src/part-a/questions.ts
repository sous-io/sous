/**
 * The questions some resolved recipes would ask, worked out before anything is downloaded: from
 * what each version's index entry records, else from a copy already in the store. `subscription add
 * --dry-run` and `recipe show` list them (ported from `planQuestions` in today's
 * `src/lib/repos/subscription-service.ts`).
 *
 * Whether something answers a question already is read from `recipe-answers.ladder` when that
 * plugin is loaded; without it, every question counts as unanswered.
 */

import type { Context } from "@sous-io/plugin-api";
import type { VariableDefinition } from "@sous-io/plugin-formats/types";
import type { PlannedQuestion, PlannedQuestions, ResolvedRecipe } from "../types.js";
import { recipeDirectory } from "./required-plugins.js";

/** The part of `recipe-answers.ladder` read here, by shape, so this plugin need not depend on it. */
interface LadderLike {
    candidates(variable: unknown): ReadonlyArray<{ readonly rung: string; readonly envName: string }>;
    resolve(variable: unknown): { readonly source: { readonly envName: string } } | undefined;
}

/** The ladder rung an answer to a variable of this scope is stored under. */
function rungOf(definition: VariableDefinition): string {
    const scope = (definition as { scope?: string }).scope;

    return scope === "recipe" ? "recipe" : scope === "namespace" ? "namespace" : "shared";
}

/** The variables a recipe declares: its index entry's, else its manifest's in the store. */
async function variablesOf(ctx: Context, recipe: ResolvedRecipe): Promise<VariableDefinition[] | undefined> {
    if (recipe.variables !== undefined) {
        return recipe.variables;
    }

    if (!ctx.services.has("formats.manifests")) {
        return undefined;
    }

    const dir = await recipeDirectory(ctx, recipe, false);

    if (dir === undefined) {
        return undefined;
    }

    try {
        return (await ctx.services.get("formats.manifests").readRecipe(dir))?.manifest.variables ?? [];
    } catch {
        return undefined;
    }
}

/** Every question the recipes ask, in recipe order, each with whether something answers it. */
export async function planQuestions(ctx: Context, resolved: readonly ResolvedRecipe[]): Promise<PlannedQuestions> {
    const ladder = ctx.services.has("recipe-answers.ladder") ? (ctx.services.get("recipe-answers.ladder" as never) as LadderLike) : undefined;
    const format = ctx.services.get("refs.format");
    const questions: PlannedQuestion[] = [];
    const unreadable: string[] = [];

    for (const recipe of [...resolved].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))) {
        const variables = await variablesOf(ctx, recipe);

        if (variables === undefined) {
            unreadable.push(recipe.key);
            continue;
        }

        for (const definition of variables) {
            const defined = {
                definition,
                recipe: { repo: recipe.repo, namespace: recipe.namespace, name: recipe.name, version: recipe.version, identity: recipe.identity },
                ref: { kind: "variable", name: definition.name, recipe: format.recipeRef(recipe.namespace, recipe.name, { repo: recipe.repo }) },
                key: `${recipe.key}.${definition.name}`,
            };
            let answered = false;
            let storedAs = definition.env;

            try {
                answered = ladder?.resolve(defined) !== undefined;
                storedAs ??= ladder?.candidates(defined).find((candidate) => candidate.rung === rungOf(definition))?.envName;
            } catch {
                // A variable the ladder cannot place is shown without where it is stored.
            }

            questions.push({ recipe: recipe.key, definition, ...(storedAs === undefined ? {} : { storedAs }), answered });
        }
    }

    return { questions, unreadable };
}
