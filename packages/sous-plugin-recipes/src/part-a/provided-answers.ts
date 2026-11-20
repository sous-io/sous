/**
 * The answers of a subscription, settled before anything is written (#230 item 1). An answer given
 * up front (`--answer`, `--answers-file`) whose name nothing declares, or that does not fit its
 * definition, fails the run with the project unchanged; then the recipes' questions are asked
 * through `recipe-answers.asking`, which holds the answers until the subscription is written.
 *
 * The reading, matching and asking are `recipe-answers`'s; without that plugin nothing is checked
 * or asked here.
 */

import { SousError, type Context, type IntentOutputs } from "@sous-io/sous-plugin-api";
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
    combine(variables: readonly DefinedLike[]): DefinedLike[];
}

/** Answers asked for and held in memory (`recipe-answers`'s `HeldAnswers`), by shape. */
export interface HeldAnswersLike {
    readonly outputs: IntentOutputs<object>;
    readonly empty: boolean;
    write(): Promise<void>;
}

/** The part of `recipe-answers.asking` read here, by shape. */
interface AskingLike {
    hold(variables: readonly DefinedLike[], input: { within: readonly string[]; answer?: readonly string[]; answersFile?: string }, ctx: Context): Promise<HeldAnswersLike>;
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
 * Asks the questions of a subscription's recipes now, before anything is written, as `vars.ask`
 * would after subscribing: what they require and nothing answers, after the answers given up front.
 * The answers are held in memory; the caller writes them with the subscription. Throws as `vars.ask`
 * does when a question cannot be asked (no terminal), or when one is declined or interrupted, with
 * nothing written. `undefined` when no plugin asks. The recipes' files must be on this machine
 * already, or their index must record their questions.
 */
export async function holdAnswers(ctx: Context, resolved: readonly ResolvedRecipe[], flags: AnswerFlags): Promise<HeldAnswersLike | undefined> {
    if (!ctx.services.has("recipe-answers.asking") || !ctx.services.has("recipe-answers.definitions")) {
        return undefined;
    }

    const definitions = ctx.services.get("recipe-answers.definitions" as never) as DefinitionsLike;
    const { defined } = await definedVariables(ctx, resolved);
    // The active recipes' definitions too, so a name they share is settled as `vars.ask` settles it;
    // an active recipe these define again is left out, since its new version replaces it.
    const replaced = new Set(defined.map((variable) => `${variable.recipe.namespace}/${variable.recipe.name}`));
    let active: DefinedLike[] = [];

    try {
        active = definitions.listSync().filter((variable) => !replaced.has(`${variable.recipe.namespace}/${variable.recipe.name}`));
    } catch {
        active = [];
    }

    const asking = ctx.services.get("recipe-answers.asking" as never) as AskingLike;

    return asking.hold(
        definitions.combine([...active, ...defined]),
        {
            within: resolved.map((recipe) => recipe.key),
            ...(flags.answer === undefined ? {} : { answer: flags.answer }),
            ...(flags.answersFile === undefined ? {} : { answersFile: flags.answersFile }),
        },
        ctx,
    );
}
