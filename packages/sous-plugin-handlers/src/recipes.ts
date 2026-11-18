/**
 * A recipe's handlers. Following law L8, a manifest's `handlers` block becomes config first: the
 * `handlers/recipe-declarations` contributor adds each handler an active recipe lists to
 * `recipes.handlers`. The `handlers/recipes` contributor responds to those values by adding a
 * `handler` entity for each one.
 *
 * Only a recipe held through `subscribes` contributes handlers (one held only through `depends` is
 * a library), and only from a repository the project trusts and has switched on, as for a
 * recipe's plugin: nothing inside a repository runs before it is trusted. A handler file is one
 * self-contained JavaScript file in the recipe, imported only when one of its handlers first runs.
 */

import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { HANDLER_PURPOSES, SousError, type ConfigBuilder, type ContributorDefinition } from "@sous-io/plugin-api";
import { insideRecipe } from "@sous-io/sous-plugin-recipes";
import type { ActiveRecipeEntity, RepoEntry } from "@sous-io/sous-plugin-recipes/types";
import type { HandlerEntity, RecipeHandlerDeclaration } from "./types.js";

/** The contributors' ids. */
export const RECIPE_DECLARATIONS_CONTRIBUTOR = "handlers/recipe-declarations";
export const RECIPE_HANDLERS_CONTRIBUTOR = "handlers/recipes";

/** The config key holding a recipe's handlers as values. */
export const RECIPE_HANDLERS_KEY = "recipes.handlers";

/** The contributor of sous-plugin-recipes that adds `active-recipe` entities. */
const FETCH_CONTRIBUTOR = "recipes.fetch";

/** The active recipes that may contribute handlers: held through `subscribes`, from a trusted, switched-on repository. */
function handlerRecipes(config: ConfigBuilder): ActiveRecipeEntity[] {
    const repos = config.atPath("repos").get<Record<string, RepoEntry>>() ?? {};

    return config.entities("active-recipe").filter((recipe) => {
        const repo = repos[recipe.repo];

        return recipe.kind === "subscribes" && repo !== undefined && repo.enabled !== false;
    });
}

/** `handlers/recipe-declarations`: each active recipe's manifest `handlers`, as `recipes.handlers` values. */
export function recipeDeclarationsContributor(): ContributorDefinition {
    return {
        id: RECIPE_DECLARATIONS_CONTRIBUTOR,
        after: [FETCH_CONTRIBUTOR],

        contribute(config) {
            for (const recipe of handlerRecipes(config)) {
                const handlers = recipe.manifest.handlers;

                if (handlers === undefined) {
                    continue;
                }

                for (const purpose of HANDLER_PURPOSES) {
                    for (const entry of handlers[purpose] ?? []) {
                        const declaration: RecipeHandlerDeclaration = { recipe: recipe.id, purpose, file: entry.file, handler: entry.handler };

                        config.atPath(RECIPE_HANDLERS_KEY).append(declaration);
                    }
                }
            }
        },
    };
}

/** The id of a recipe's handler: `voltagrid/knowledge-worker/check/checkCommands`. */
export function recipeHandlerId(declaration: RecipeHandlerDeclaration): string {
    return `${declaration.recipe}/${declaration.purpose}/${declaration.handler}`;
}

/**
 * The function a recipe's handler runs: imports the file when first called, then calls its export.
 * A missing file or export fails that call, with a message naming the recipe.
 */
export function loadRecipeHandler(declaration: RecipeHandlerDeclaration, file: string): HandlerEntity["handle"] {
    return (async (sous: unknown, input: unknown) => {
        if (!fs.existsSync(file)) {
            throw new SousError(`The recipe ${declaration.recipe} lists the handler file ${declaration.file}, which is not there.`);
        }

        const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
        const handle = module[declaration.handler];

        if (typeof handle !== "function") {
            throw new SousError(`The recipe ${declaration.recipe} lists the handler ${declaration.handler} in ${declaration.file}, which does not export a function by that name.`);
        }

        return (handle as (sous: unknown, input: unknown) => unknown)(sous, input);
    }) as HandlerEntity["handle"];
}

/** `handlers/recipes`: a `handler` entity for each entry of `recipes.handlers` from a recipe that may contribute handlers. */
export function recipeHandlersContributor(): ContributorDefinition {
    return {
        id: RECIPE_HANDLERS_CONTRIBUTOR,
        after: [RECIPE_DECLARATIONS_CONTRIBUTOR, FETCH_CONTRIBUTOR],

        contribute(config) {
            const recipes = new Map(handlerRecipes(config).map((recipe) => [recipe.id, recipe]));
            const declarations = config.atPath(RECIPE_HANDLERS_KEY).get<RecipeHandlerDeclaration[]>() ?? [];
            const used = new Map<string, number>();
            const seen = new Set<string>();

            for (const declaration of declarations) {
                const recipe = recipes.get(declaration.recipe);

                if (recipe === undefined) {
                    continue;
                }

                // The same entry twice (two contributors declaring one manifest) is one handler.
                const identity = JSON.stringify([declaration.recipe, declaration.purpose, declaration.file, declaration.handler]);

                if (seen.has(identity)) {
                    continue;
                }

                seen.add(identity);

                const file = insideRecipe(recipe.dir, declaration.file);

                if (file === undefined) {
                    config.warn(`The recipe ${recipe.id} names a handler file outside its own files (${declaration.file}), so its handler ${declaration.handler} was not added.`);
                    continue;
                }

                const base = recipeHandlerId(declaration);
                const count = (used.get(base) ?? 0) + 1;

                used.set(base, count);

                const entity: HandlerEntity = {
                    id: count === 1 ? base : `${base}#${count}`,
                    purpose: declaration.purpose,
                    recipe: recipe.id,
                    source: `${declaration.file}#${declaration.handler}`,
                    handle: loadRecipeHandler(declaration, file),
                };

                config.addEntity("handler", entity);
            }
        },
    };
}
