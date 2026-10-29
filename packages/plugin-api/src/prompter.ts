import { NonInteractiveError } from "./errors.js";

/**
 * Asking questions (L3, L4). Services never prompt: they ask through the `Prompter` the front end
 * handed over with the chain (`ctx.prompter`). Every question names the flag or argument that
 * answers it without a prompt, so an agent can do everything a person can.
 */

/** What every question carries. */
export interface QuestionBase {
    /** The question, as a person would read it: `Remove the 3 files listed above?` */
    message: string;
    /**
     * The flag or argument that answers this question ahead of time (`--yes`, `--harness <id>`).
     * A prompter that cannot ask names it in its error (L4).
     */
    answeredBy?: string;
}

/** A question answered with free text. */
export interface ValueQuestion extends QuestionBase {
    /** The answer used when the person just presses enter. */
    default?: string;
    /** Returns a message when the answer is not acceptable, so the prompter asks again. */
    validate?: (answer: string) => string | undefined;
    /** Hides what is typed, for secrets. */
    secret?: boolean;
}

/** One option of a {@link ChoiceQuestion}. */
export interface Choice<T> {
    /** What the person sees. */
    label: string;
    value: T;
    /** One more line about the option. */
    description?: string;
}

/** A question answered by picking one option. */
export interface ChoiceQuestion<T> extends QuestionBase {
    choices: ReadonlyArray<Choice<T>>;
    /** The index of the option picked when the person just presses enter. */
    defaultIndex?: number;
}

/** A yes-or-no question. */
export interface ConfirmQuestion extends QuestionBase {
    /** The answer used when the person just presses enter. */
    default?: boolean;
}

/** Where a chain's questions go. Each front end supplies its own. */
export interface Prompter {
    /** Whether this prompter can ask anything at all in this run. */
    readonly interactive: boolean;
    /** Asks for free text. Throws `NonInteractiveError` naming `answeredBy` when it cannot ask. */
    askValue(question: ValueQuestion): Promise<string>;
    /** Asks the person to pick one option. */
    askChoice<T>(question: ChoiceQuestion<T>): Promise<T>;
    /** Asks a yes-or-no question. */
    confirm(question: ConfirmQuestion): Promise<boolean>;
}

/**
 * A prompter that never asks: every question fails with a `NonInteractiveError` naming the flag that
 * answers it. Used when nothing can answer, such as in CI or a background intent.
 */
export const nonInteractivePrompter: Prompter = {
    interactive: false,
    askValue: (question) => Promise.reject(new NonInteractiveError(question.message, question.answeredBy)),
    askChoice: (question) => Promise.reject(new NonInteractiveError(question.message, question.answeredBy)),
    confirm: (question) => Promise.reject(new NonInteractiveError(question.message, question.answeredBy)),
};

/**
 * A prompter that answers from a list of prepared answers, in order, for tests and for front ends
 * that collect answers up front. Running out of answers fails like {@link nonInteractivePrompter}.
 */
export function scriptedPrompter(answers: unknown[]): Prompter & { readonly asked: string[] } {
    const asked: string[] = [];
    const next = <T>(question: QuestionBase): Promise<T> => {
        asked.push(question.message);

        if (answers.length === 0) {
            return Promise.reject(new NonInteractiveError(question.message, question.answeredBy));
        }

        return Promise.resolve(answers.shift() as T);
    };

    return {
        interactive: true,
        asked,
        askValue: (question) => next<string>(question),
        askChoice: <T>(question: ChoiceQuestion<T>) => next<T>(question),
        confirm: (question) => next<boolean>(question),
    };
}
