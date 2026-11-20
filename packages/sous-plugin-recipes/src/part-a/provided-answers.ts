/**
 * Checking the answers a subscription was given up front (`--answer`, `--answers-file`) before
 * anything is written, as before the refactor: an answer whose name nothing declares, or that does
 * not fit its definition, fails the run with the project unchanged. Storing them is `vars.ask`'s
 * job, after subscribing.
 *
 * The reading and matching are `recipe-answers.preanswers`'s; without that plugin nothing is
 * checked here.
 */

import { NonInteractiveError, SousError, type Context } from "@sous-io/sous-plugin-api";
import type { AnswerFlags, ResolvedRecipe } from "../types.js";
import { definedVariables, plannedQuestionsOf, RUNG_LABELS, type DefinedLike } from "./questions.js";
import { hasIntent } from "./util.js";

/** The part of `recipe-answers.preanswers` read here, by shape. */
interface PreanswersLike {
    read(inputs: { answer?: readonly string[]; answersFile?: string }): Promise<unknown[]>;
    match(answers: readonly unknown[], variables: readonly unknown[]): Array<{ readonly target: { readonly definition: { readonly name: string } } }>;
}

/** The part of `recipe-answers.definitions` read here, by shape. */
interface DefinitionsLike {
    listSync(): DefinedLike[];
}

/**
 * Throws when an answer given up front names nothing in the subscription's recipes or this
 * project's, or does not fit its definition. With `download`, a recipe whose index does not record
 * its questions is downloaded to read them.
 */
export async function checkProvidedAnswers(ctx: Context, resolved: readonly ResolvedRecipe[], flags: AnswerFlags, download: boolean): Promise<void> {
    if ((flags.answer === undefined || flags.answer.length === 0) && flags.answersFile === undefined) {
        return;
    }

    if (!ctx.services.has("recipe-answers.preanswers")) {
        return;
    }

    const preanswers = ctx.services.get("recipe-answers.preanswers" as never) as PreanswersLike;
    const { defined } = await definedVariables(ctx, resolved, download);
    const keys = new Set(defined.map((variable) => variable.key));
    let existing: DefinedLike[] = [];

    try {
        existing = ctx.services.has("recipe-answers.definitions") ? (ctx.services.get("recipe-answers.definitions" as never) as DefinitionsLike).listSync() : [];
    } catch {
        existing = [];
    }

    try {
        const answers = await preanswers.read({ ...(flags.answer === undefined ? {} : { answer: flags.answer }), ...(flags.answersFile === undefined ? {} : { answersFile: flags.answersFile }) });

        preanswers.match(answers, [...defined, ...existing.filter((variable) => !keys.has(variable.key))]);
    } catch (error) {
        // The preanswers error is worded for `vars.ask`'s input; here it is the subscription's.
        if (error instanceof SousError && error.details.length > 0) {
            const [first, ...rest] = error.details;

            throw new SousError(first ?? error.message, { details: rest });
        }

        throw error;
    }
}

/**
 * Throws, before anything is written, when there is no terminal to ask on and a variable the
 * recipes require would have no answer: none in scope, none given up front (`--answer`,
 * `--answers-file`), and no default. `vars.ask`, which runs after subscribing, would fail on it
 * once the subscription was already recorded. The recipes' files must be on this machine already
 * (or their index must record their questions).
 *
 * ```text
 * Error: One variable still needs an answer, and there is no terminal to ask on.
 *   Nothing was written. Set one of the environment variables listed under each variable, ...
 *   region (acme/gadget): Which region does the agent deploy to?
 *     SOUS_VAR_ACME_GADGET_REGION  (recipe scope)
 * ```
 */
export async function checkAnswerable(ctx: Context, resolved: readonly ResolvedRecipe[], flags: AnswerFlags): Promise<void> {
    if (ctx.prompter.interactive || !hasIntent(ctx, "vars.ask")) {
        return;
    }

    const { defined } = await definedVariables(ctx, resolved);
    // Without `recipe-answers.preanswers` to match them, each `--answer` counts by the name before its `=`.
    const given = new Set<string>(ctx.services.has("recipe-answers.preanswers") ? [] : (flags.answer ?? []).map((entry) => entry.slice(0, Math.max(0, entry.indexOf("="))).trim()));

    if (((flags.answer !== undefined && flags.answer.length > 0) || flags.answersFile !== undefined) && ctx.services.has("recipe-answers.preanswers")) {
        const preanswers = ctx.services.get("recipe-answers.preanswers" as never) as PreanswersLike;
        const answers = await preanswers.read({ ...(flags.answer === undefined ? {} : { answer: flags.answer }), ...(flags.answersFile === undefined ? {} : { answersFile: flags.answersFile }) });
        let existing: DefinedLike[] = [];

        try {
            existing = ctx.services.has("recipe-answers.definitions") ? (ctx.services.get("recipe-answers.definitions" as never) as DefinitionsLike).listSync() : [];
        } catch {
            existing = [];
        }

        for (const applied of preanswers.match(answers, [...defined, ...existing])) {
            given.add(applied.target.definition.name);
        }
    }

    const missing = plannedQuestionsOf(ctx, defined).filter(
        (question) =>
            question.definition.required === true &&
            !question.answered &&
            question.unanswerable === undefined &&
            question.definition.default === undefined &&
            !given.has(question.definition.name),
    );

    if (missing.length === 0) {
        return;
    }

    const first = missing[0]!;
    const error = new NonInteractiveError(
        missing.length === 1 ? first.definition.prompt : `${missing.length} questions about recipe variables`,
        missing.length === 1 ? `--answer ${first.definition.name}=<value>` : "--answer <name>=<value>",
        {
            details: [
                "Nothing was written. Set one of the environment variables listed under each variable, pass --answer <name>=<value>, or run the command from a terminal.",
                ...missing.flatMap((question) => [
                    `${question.definition.name} (${question.recipe}): ${question.definition.prompt}`,
                    ...candidatesOf(ctx, defined, question.recipe, question.definition.name).map((candidate) => `  ${candidate.envName}  (${RUNG_LABELS[candidate.rung] ?? candidate.rung})`),
                ]),
            ],
            exitCode: 1,
        },
    );

    error.message = missing.length === 1 ? "One variable still needs an answer, and there is no terminal to ask on." : `${missing.length} variables still need answers, and there is no terminal to ask on.`;

    throw error;
}

/** The environment names that would answer a variable, most specific first, from `recipe-answers.ladder`. */
function candidatesOf(ctx: Context, defined: readonly DefinedLike[], recipe: string, name: string): Array<{ rung: string; envName: string }> {
    const variable = defined.find((entry) => `${entry.recipe.namespace}/${entry.recipe.name}` === recipe && entry.definition.name === name);

    if (variable === undefined || !ctx.services.has("recipe-answers.ladder")) {
        return [];
    }

    try {
        return (ctx.services.get("recipe-answers.ladder" as never) as { candidates(variable: unknown): Array<{ rung: string; envName: string }> }).candidates(variable);
    } catch {
        return [];
    }
}
