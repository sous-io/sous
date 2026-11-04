/**
 * The answers a build uses.
 *
 * A recipe publishes variable definitions; the shell and the env files hold the answers; the
 * ladder says which answer a definition gets. This turns them into the variable scopes templates
 * render with, so a `{{ variable }}` in a recipe's own files sees the answer to its own question.
 *
 * - `merged`: one value per variable name, for the project's own templates. Two recipes may define
 *   the same name; their definitions are combined into one (`combine.ts`), so they share one
 *   answer. When they could not be combined, each recipe has its own answer and the first in
 *   recipe order fills the merged view; a project that wants something else says so in `_vars`,
 *   which sits above every answer.
 * - `byRecipe`: the answers for each recipe's own definitions, which the recipe-scoped rung can make
 *   differ from the merged view.
 * - `unanswered`: every required definition nothing answered and with no default. Requirements and
 *   defaults are read from the combined definition, so a default another definition rules out
 *   does not count. A build reports
 *   them and carries on.
 * - `unanswerable`: every definition that gets no answer because another version of its recipe is
 *   asked instead (`DefinedVariable.unanswerable`). Its default does not apply either, and each
 *   recipe holding that version sees the name empty in its own scope, unless the holder defines
 *   the name itself. A build reports them and carries on.
 * - `secrets`: every name some definition declares secret.
 *
 * A definition's `default` is the answer of last resort. Values are laid in as stored: nothing
 * here resolves a path or coerces a number.
 */

import type { VarScope } from "@sous-io/plugin-variables/types";
import { recipeKey } from "./definitions.js";
import type { Ladder } from "./ladder.js";
import type { DefinedVariable, RecipeAnswers, RecipeAnswersAnswers } from "./types.js";

/** The answers of a project that defines no variables. */
export function noRecipeAnswers(): RecipeAnswers {
    return { merged: {}, byRecipe: {}, unanswered: [], unanswerable: [], secrets: new Set() };
}

/** The answer one definition renders with: what the ladder found, else its default. */
export function answerFor(variable: DefinedVariable, ladder: Pick<Ladder, "resolve">): string | undefined {
    if (variable.unanswerable !== undefined) {
        return undefined;
    }

    const resolved = ladder.resolve(variable);

    if (resolved !== undefined) {
        return resolved.value;
    }

    const fallback = variable.definition.default;

    return fallback === undefined ? undefined : String(fallback);
}

/** Resolves every definition through the ladder, in the views a build needs. */
export function computeAnswers(variables: readonly DefinedVariable[], ladder: Pick<Ladder, "resolve">): RecipeAnswers {
    const merged: Record<string, string> = {};
    const byRecipe: Record<string, Record<string, string>> = {};
    const unanswered: DefinedVariable[] = [];
    const unanswerable: DefinedVariable[] = [];
    const secrets = new Set<string>();

    for (const variable of variables) {
        const name = variable.definition.name;
        const value = answerFor(variable, ladder);

        if (variable.definition.secret) {
            secrets.add(name);
        }

        if (variable.unanswerable !== undefined) {
            unanswerable.push(variable);
            continue;
        }

        if (value === undefined) {
            if (variable.definition.required) {
                unanswered.push(variable);
            }

            continue;
        }

        if (!(name in merged)) {
            merged[name] = value;
        }

        const key = recipeKey(variable.recipe);

        byRecipe[key] = { ...(byRecipe[key] ?? {}), [name]: value };
    }

    // A holder of a version that gets no answer renders the name empty, not the answer another
    // version was given, unless the holder defines the name itself.
    for (const variable of unanswerable) {
        const name = variable.definition.name;

        for (const holder of variable.recipe.holders ?? []) {
            const ownsName = variables.some((other) => other.definition.name === name && recipeKey(other.recipe) === holder);

            if (!ownsName) {
                byRecipe[holder] = { ...(byRecipe[holder] ?? {}), [name]: "" };
            }
        }
    }

    return { merged, byRecipe, unanswered, unanswerable, secrets };
}

/** A recipe's own scope: the merged answers with its own laid over. */
export function answersForRecipe(answers: RecipeAnswers, key: string): VarScope {
    return { ...answers.merged, ...(answers.byRecipe[key] ?? {}) };
}

/**
 * The one warning a build reports when required variables have no answer, or `undefined` when
 * none is missing. A variable the render scope already holds (set in `_vars` or `_env`) is not
 * missing.
 *
 * ```text
 * 1 required recipe variable has no answer, so the templates that use it render an empty value:
 *   • apiUrl (asked by misc/stuff)
 * Run 'sous vars ask' to answer it.
 * ```
 */
export function unansweredWarning(answers: RecipeAnswers, renderScope: VarScope = {}): string | undefined {
    const missing = answers.unanswered.filter((variable) => renderScope[variable.definition.name] === undefined);

    if (missing.length === 0) {
        return undefined;
    }

    const count = missing.length;
    const noun = count === 1 ? "variable" : "variables";
    const pronoun = count === 1 ? "it" : "them";
    const lines = missing.map((variable) => `  • ${variable.definition.name} (asked by ${recipeKey(variable.recipe)})`);

    return (
        `${count} required recipe ${noun} ${count === 1 ? "has" : "have"} no answer, so the ` +
        `templates that use ${pronoun} render an empty value:\n` +
        `${lines.join("\n")}\n` +
        `Run 'sous vars ask' to answer ${pronoun}.`
    );
}

/** The `recipe-answers.answers` service: answers computed once per config. */
export class AnswersService implements RecipeAnswersAnswers {
    private cached: RecipeAnswers | undefined;

    constructor(private readonly compute: () => RecipeAnswers) {}

    get(): RecipeAnswers {
        this.cached ??= this.compute();

        return this.cached;
    }

    forRecipe(key: string): VarScope {
        return answersForRecipe(this.get(), key);
    }
}
