/**
 * The questions some resolved recipes would ask, worked out before anything is downloaded: from
 * what each version's index entry records, else from a copy already in the store. `subscription add
 * --dry-run` and `recipe show` list them (ported from `planQuestions` in today's
 * `src/lib/repos/subscription-service.ts`).
 *
 * Whether something answers a question already is read from `recipe-answers.ladder` when that
 * plugin is loaded; without it, every question counts as unanswered.
 */

import path from "node:path";
import type { Context } from "@sous-io/plugin-api";
import type { VariableDefinition } from "@sous-io/plugin-formats/types";
import type { PlannedQuestion, PlannedQuestions, ResolvedRecipe } from "../types.js";
import { recipeDirectory } from "./required-plugins.js";

/** The part of `recipe-answers.ladder` read here, by shape, so this plugin need not depend on it. */
interface LadderLike {
    bareName(variable: unknown): string;
    resolve(variable: unknown): { readonly source: { readonly rung: string; readonly envName: string; readonly file: string } } | undefined;
}

/** The ladder's rungs, in words, as `sous vars` names them. */
const RUNG_LABELS: Readonly<Record<string, string>> = {
    mapping: "mapping record",
    recipe: "recipe scope",
    namespace: "namespace scope",
    shared: "shared scope",
    bare: "declared name",
};

/** The env file an answer is written to: a secret or a machine-specific one goes in the gitignored file. */
function envFileOf(definition: VariableDefinition): string {
    return definition.secret === true || (definition as { scope?: string }).scope === "local" ? ".env.local" : ".env";
}

/** Where an answer was found, in words: `the shared scope name SOUS_VAR_X, from the .env file`. */
function describeSource(source: { readonly rung: string; readonly envName: string; readonly file: string }): string {
    const where = source.file === "shell" ? "the shell environment" : source.file === "local" ? "the .env.local file" : "the .env file";

    return `the ${RUNG_LABELS[source.rung] ?? source.rung} name ${source.envName}, from ${where}`;
}

/** The variables a recipe declares: its index entry's, else its manifest's (downloaded only when `download`). */
async function variablesOf(ctx: Context, recipe: ResolvedRecipe, download: boolean): Promise<VariableDefinition[] | undefined> {
    if (recipe.variables !== undefined) {
        return recipe.variables;
    }

    if (!ctx.services.has("formats.manifests")) {
        return undefined;
    }

    const dir = await recipeDirectory(ctx, recipe, download);

    if (dir === undefined) {
        return undefined;
    }

    try {
        return (await ctx.services.get("formats.manifests").readRecipe(dir))?.manifest.variables ?? [];
    } catch {
        return undefined;
    }
}

/**
 * A variable in the shape `recipe-answers` reads (its `DefinedVariable`), built here by shape so this
 * plugin need not depend on it.
 */
export interface DefinedLike {
    readonly definition: VariableDefinition;
    readonly recipe: { readonly repo: string; readonly namespace: string; readonly name: string; readonly version: string; readonly identity: string };
    readonly ref: { readonly kind: "variable"; readonly name: string; readonly recipe: unknown };
    readonly key: string;
}

/** Every variable the recipes define, in recipe order, and the recipes whose variables are not known. */
export async function definedVariables(ctx: Context, resolved: readonly ResolvedRecipe[], download = false): Promise<{ defined: DefinedLike[]; unreadable: string[] }> {
    const format = ctx.services.get("refs.format");
    const defined: DefinedLike[] = [];
    const unreadable: string[] = [];

    for (const recipe of [...resolved].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))) {
        const variables = await variablesOf(ctx, recipe, download);

        if (variables === undefined) {
            unreadable.push(recipe.key);
            continue;
        }

        for (const definition of variables) {
            defined.push({
                definition,
                recipe: { repo: recipe.repo, namespace: recipe.namespace, name: recipe.name, version: recipe.version, identity: recipe.identity },
                ref: { kind: "variable", name: definition.name, recipe: format.recipeRef(recipe.namespace, recipe.name, { repo: recipe.repo }) },
                key: `${recipe.key}.${definition.name}`,
            });
        }
    }

    return { defined, unreadable };
}

/** Every question the recipes ask, in recipe order, each with whether something answers it. */
export async function planQuestions(ctx: Context, resolved: readonly ResolvedRecipe[]): Promise<PlannedQuestions> {
    const ladder = ctx.services.has("recipe-answers.ladder") ? (ctx.services.get("recipe-answers.ladder" as never) as LadderLike) : undefined;
    const { defined, unreadable } = await definedVariables(ctx, resolved);
    const questions: PlannedQuestion[] = [];

    for (const variable of defined) {
        const { definition } = variable;
        let found: ReturnType<LadderLike["resolve"]>;
        let storedAs: string | undefined;

        try {
            found = ladder?.resolve(variable);
            storedAs = ladder?.bareName(variable);
        } catch {
            // A variable the ladder cannot place is shown without where it is stored.
        }

        questions.push({
            recipe: `${variable.recipe.namespace}/${variable.recipe.name}`,
            definition,
            ...(storedAs === undefined ? {} : { storedAs }),
            ...(ctx.project === undefined ? {} : { storagePath: path.join(ctx.project.sousDir, envFileOf(definition)) }),
            answered: found !== undefined,
            ...(found === undefined ? {} : { answeredFrom: describeSource(found.source) }),
        });
    }

    return { questions, unreadable };
}
