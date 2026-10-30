/**
 * Checking an answer against the definition that asked for it.
 *
 * A recipe declares a small constraint vocabulary (a type, plus `pattern`, `minLength`,
 * `maxLength`, `min`, `max` and `enum`), all plain JSON so a manifest never carries code. A failure
 * is reported in plain words, naming the constraint the answer broke.
 *
 * Answers are stored as text in env files, so a check always starts from a string and hands back
 * the coerced value.
 *
 * A `pattern` comes from a recipe, which is code from somewhere else, so it never runs on this
 * thread without a time limit (see `safe-regex.ts`). A pattern that runs out of time fails the
 * check, and the message says the pattern is the problem, not the answer.
 */

import type { VariableDefinition, VariableScalar } from "@sous-io/plugin-formats/types";
import type { AnswerValidation, RecipeAnswersValidator } from "./types.js";
import { DEFAULT_PATTERN_BUDGET_MS, matchWithBudget } from "./safe-regex.js";

/** What the caller knows about where a definition came from, for messages. */
export interface ValidationContext {
    /** The recipe that published the definition (`acme/web-app`); described in words when left out. */
    recipe?: string;
    /** How long a declared pattern may run, in milliseconds. */
    patternBudgetMs?: number;
}

/** The words accepted as a true answer for a boolean variable. */
const TRUE_WORDS = new Set(["true", "yes", "y", "on", "1"]);

/** The words accepted as a false answer for a boolean variable. */
const FALSE_WORDS = new Set(["false", "no", "n", "off", "0"]);

/** One check: the reason it failed, or `undefined`. */
type Check = (value: string) => string | undefined;

/**
 * Checks one answer against its definition.
 *
 * ```ts
 * validateAnswer({ name: "port", type: "number", validate: { max: 9 }, ... }, "12");
 * // -> { ok: false, message: "port must be at most 9." }
 * ```
 *
 * @param definition - The definition the answer is for.
 * @param raw - The answer as text, as typed or as read from an env file.
 * @param context - What is known about the recipe, for the pattern message.
 * @returns The coerced value, or a plain message naming what is wrong.
 */
export function validateAnswer(definition: VariableDefinition, raw: string, context: ValidationContext = {}): AnswerValidation {
    const trimmed = typeof raw === "string" ? raw.trim() : "";

    if (trimmed.length === 0 && !definition.required) {
        return { ok: true, value: "" };
    }

    const rules = definition.validate;
    const fail = (reason: string): AnswerValidation => ({ ok: false, message: `${definition.name} ${reason}.` });

    switch (definition.type) {
        case "number": {
            if (trimmed.length === 0 || !Number.isFinite(Number(trimmed))) {
                return fail("must be a number");
            }

            const value = Number(trimmed);

            if (rules?.min !== undefined && value < rules.min) {
                return fail(`must be at least ${rules.min}`);
            }

            if (rules?.max !== undefined && value > rules.max) {
                return fail(`must be at most ${rules.max}`);
            }

            return { ok: true, value };
        }

        case "boolean": {
            const word = trimmed.toLowerCase();

            if (!TRUE_WORDS.has(word) && !FALSE_WORDS.has(word)) {
                return fail("must be 'true' or 'false'");
            }

            return { ok: true, value: TRUE_WORDS.has(word) };
        }

        case "enum": {
            const options = rules?.enum ?? [];

            return runString(trimmed, [(value) => (options.includes(value) ? undefined : `must be one of: ${options.join(", ")}`), ...stringChecks()]);
        }

        case "url":
            return runString(trimmed, [(value) => (isUrl(value) ? undefined : "must be a URL, including its scheme (for example 'https://example.com')"), ...stringChecks()]);

        case "path":
            return runString(trimmed, [(value) => (value.includes("\0") ? "must be a filesystem path, with no null characters in it" : undefined), ...stringChecks()]);

        case "string":
        default:
            return runString(trimmed, stringChecks());
    }

    /** Runs the checks in order; the first failure is the message. */
    function runString(value: string, checks: readonly Check[]): AnswerValidation {
        for (const check of checks) {
            const reason = check(value);

            if (reason !== undefined) {
                return fail(reason);
            }
        }

        return { ok: true, value };
    }

    /** The string constraints, the rule that a required answer is not empty first. */
    function stringChecks(): Check[] {
        const checks: Check[] = [];

        if (definition.required) {
            checks.push((value) => (value.length > 0 ? undefined : "must not be empty"));
        }

        if (rules?.minLength !== undefined) {
            const min = rules.minLength;

            checks.push((value) => (value.length >= min ? undefined : `must be at least ${min} characters long`));
        }

        if (rules?.maxLength !== undefined) {
            const max = rules.maxLength;

            checks.push((value) => (value.length <= max ? undefined : `must be at most ${max} characters long`));
        }

        if (rules?.pattern !== undefined) {
            const pattern = rules.pattern;
            const budget = context.patternBudgetMs ?? DEFAULT_PATTERN_BUDGET_MS;

            checks.push((value) => {
                const outcome = matchWithBudget(pattern, value, budget);

                if (outcome === "match") {
                    return undefined;
                }

                return outcome === "timeout" ? patternTooSlowMessage(pattern, budget, context.recipe) : `must match the pattern ${pattern}`;
            });
        }

        return checks;
    }
}

/** Whether text is a URL with a scheme. */
function isUrl(value: string): boolean {
    try {
        return new URL(value).protocol.length > 1;
    } catch {
        return false;
    }
}

/**
 * The failure for a pattern that ran out of time. It names the pattern and the recipe, and says
 * plainly that the pattern is the problem; no answer would finish a runaway pattern.
 */
function patternTooSlowMessage(pattern: string, budgetMs: number, recipe?: string): string {
    const publisher = recipe === undefined ? "the recipe that defines it" : `the recipe ${recipe}`;

    return (
        `could not be checked: the pattern ${pattern}, published by ${publisher}, ` +
        `took longer than ${budgetMs} milliseconds to run, so sous stopped waiting ` +
        "for it. The pattern is too slow to run, and the answer was not the problem; " +
        "this needs to be reported to whoever publishes the recipe"
    );
}

/**
 * The form an answer is stored in: env files hold text, so a number or boolean goes back to its
 * canonical string.
 */
export function storedForm(value: VariableScalar): string {
    return String(value);
}

/**
 * A short summary of a definition's constraints, shown beside a question. The type is always
 * first.
 */
export function constraintHints(definition: VariableDefinition): string[] {
    const hints: string[] = [];
    const rules = definition.validate;

    hints.push(`type: ${definition.type}`);

    if (definition.type === "enum" && rules?.enum !== undefined) {
        hints.push(`one of: ${rules.enum.join(", ")}`);
    }

    if (rules?.minLength !== undefined) hints.push(`at least ${rules.minLength} characters`);
    if (rules?.maxLength !== undefined) hints.push(`at most ${rules.maxLength} characters`);
    if (rules?.min !== undefined) hints.push(`no less than ${rules.min}`);
    if (rules?.max !== undefined) hints.push(`no more than ${rules.max}`);
    if (rules?.pattern !== undefined) hints.push(`matching ${rules.pattern}`);
    if (!definition.required) hints.push("optional");

    return hints;
}

/** A character count with the noun in the right number. */
function characters(count: number): string {
    return count === 1 ? "1 character" : `${count} characters`;
}

/**
 * One sentence per constraint, in plain words with the raw form the manifest declared in
 * parentheses, so a reader can understand the rule and find it in the recipe. `vars.show` returns
 * these.
 *
 * ```ts
 * constraintBullets(definition);
 * // -> ["must be a value of the type url (type: url)", "must match the pattern /^https/ (pattern: ^https)"]
 * ```
 */
export function constraintBullets(definition: VariableDefinition): string[] {
    const rules = definition.validate;
    const options = rules?.enum;

    // No article in front of the type name, since it would change with the name ("a path", "an
    // enum"). An enum is described by its options, which says more than the word "enum".
    const bullets: string[] =
        definition.type === "enum" && options !== undefined
            ? [`must be one of: ${options.join(", ")} (type: enum)`]
            : [`must be a value of the type ${definition.type} (type: ${definition.type})`];

    if (options !== undefined && definition.type !== "enum") {
        bullets.push(`must be one of: ${options.join(", ")} (enum: ${options.join(", ")})`);
    }

    if (rules?.minLength !== undefined) {
        bullets.push(`must be at least ${characters(rules.minLength)} long (minLength: ${rules.minLength})`);
    }

    if (rules?.maxLength !== undefined) {
        bullets.push(`must be at most ${characters(rules.maxLength)} long (maxLength: ${rules.maxLength})`);
    }

    if (rules?.min !== undefined) bullets.push(`must be no less than ${rules.min} (min: ${rules.min})`);
    if (rules?.max !== undefined) bullets.push(`must be no more than ${rules.max} (max: ${rules.max})`);
    if (rules?.pattern !== undefined) bullets.push(`must match the pattern /${rules.pattern}/ (pattern: ${rules.pattern})`);
    if (!definition.required) bullets.push("an answer is optional");

    return bullets;
}

/** The `recipe-answers.validator` service. */
export const validator: RecipeAnswersValidator = {
    validate: (definition, answer, options) => validateAnswer(definition, answer, options),
};
