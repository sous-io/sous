/**
 * Checking the answers a subscription was given up front (`--answer`, `--answers-file`) before
 * anything is written, as before the refactor: an answer whose name nothing declares, or that does
 * not fit its definition, fails the run with the project unchanged. Storing them is `vars.ask`'s
 * job, after subscribing.
 *
 * The reading and matching are `recipe-answers.preanswers`'s; without that plugin nothing is
 * checked here.
 */

import { SousError, type Context } from "@sous-io/plugin-api";
import type { AnswerFlags, ResolvedRecipe } from "../types.js";
import { definedVariables, type DefinedLike } from "./questions.js";

/** The part of `recipe-answers.preanswers` read here, by shape. */
interface PreanswersLike {
    read(inputs: { answer?: readonly string[]; answersFile?: string }): Promise<unknown[]>;
    match(answers: readonly unknown[], variables: readonly unknown[]): unknown[];
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
