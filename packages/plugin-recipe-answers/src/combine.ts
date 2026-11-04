/**
 * Combining the definitions of one variable name (ADR 0023, decision 6).
 *
 * Answers are shared by name, so when several recipes (or several versions of one recipe) define a
 * variable of the same name, one question is asked, built from the strictest combination of every
 * definition:
 *
 * - `secret` when any definition is secret, `scope: local` when any is local, `required` when any is
 *   required;
 * - only the values every definition accepts: the shared `enum` options, the highest `min` and
 *   `minLength`, the lowest `max` and `maxLength`, and every `pattern`;
 * - the first definition's prompt, description and example, and the first `default` that passes the
 *   combination (a default that fails it is dropped).
 *
 * When no value could pass (different types, no shared `enum` option, an empty range), the
 * definitions are not combined, and the result says why, naming the definitions.
 *
 * This module is the one owner of that rule: asking, validating a stored answer and anything else
 * that needs "the definition of name X" read the combination it builds. It does not care where the
 * definitions come from, only what each one is called in a message.
 */

import type { VariableDefinition, VariableValidation } from "@sous-io/plugin-formats/types";
import type { AnswerDefinition } from "./types.js";
import { validateAnswer } from "./validate.js";

/** One definition to combine, and how a message names where it came from (`misc/stuff`, `misc/stuff 1.2.0`). */
export interface Definer {
    readonly definition: VariableDefinition;
    readonly label: string;
}

/** The combination of several definitions, or why there is none. */
export type Combination = { readonly ok: true; readonly definition: AnswerDefinition } | { readonly ok: false; readonly reason: string };

/** The tightest bound of one numeric field, and the definition that set it. */
function tightest(definers: readonly Definer[], field: "min" | "max" | "minLength" | "maxLength"): { value: number; label: string } | undefined {
    const lower = field === "min" || field === "minLength";
    let best: { value: number; label: string } | undefined;

    for (const { definition, label } of definers) {
        const value = definition.validate?.[field];

        if (value !== undefined && (best === undefined || (lower ? value > best.value : value < best.value))) {
            best = { value, label };
        }
    }

    return best;
}

/**
 * Combines every definition of one variable name into the strictest one, or says why that is not
 * possible. A single definition is returned unchanged.
 *
 * ```ts
 * combineDefinitions([
 *     { label: "misc/stuff", definition: { name: "port", type: "number", validate: { min: 1000 }, ... } },
 *     { label: "misc/other", definition: { name: "port", type: "number", validate: { max: 9000 }, secret: true, scope: "local", ... } },
 * ]);
 * // -> { ok: true, definition: { name: "port", type: "number", validate: { min: 1000, max: 9000 }, secret: true, scope: "local", ... } }
 *
 * combineDefinitions([
 *     { label: "misc/stuff", definition: { name: "port", type: "number", ... } },
 *     { label: "misc/other", definition: { name: "port", type: "string", ... } },
 * ]);
 * // -> { ok: false, reason: "misc/stuff defines port as a number, and misc/other defines it as a string, so no answer fits both." }
 * ```
 *
 * @param definers - The definitions, first one first; the first lends its prompt, description and example.
 */
export function combineDefinitions(definers: readonly Definer[]): Combination {
    const [first] = definers;

    if (first === undefined) {
        throw new Error("combineDefinitions needs at least one definition.");
    }

    if (definers.length === 1) {
        return { ok: true, definition: first.definition };
    }

    const name = first.definition.name;
    const otherType = definers.find((entry) => entry.definition.type !== first.definition.type);

    if (otherType !== undefined) {
        return {
            ok: false,
            reason: `${first.label} defines ${name} as ${article(first.definition.type)}, and ${otherType.label} defines it as ${article(otherType.definition.type)}, so no answer fits both.`,
        };
    }

    // The enum options every definition that lists some accepts, in the first list's order.
    const listing = definers.filter((entry) => entry.definition.validate?.enum !== undefined);
    let options: string[] | undefined;

    for (const entry of listing) {
        const own = entry.definition.validate!.enum!;

        options = options === undefined ? [...own] : options.filter((option) => own.includes(option));
    }

    if (options !== undefined && options.length === 0) {
        const lists = listing.map((entry) => `${entry.label} accepts ${entry.definition.validate!.enum!.join(", ")}`);

        return { ok: false, reason: `No value of ${name} is accepted by every definition (${lists.join("; ")}).` };
    }

    const min = tightest(definers, "min");
    const max = tightest(definers, "max");

    if (min !== undefined && max !== undefined && min.value > max.value) {
        return {
            ok: false,
            reason: `${min.label} requires ${name} to be at least ${min.value}, and ${max.label} requires it to be at most ${max.value}, so no answer fits both.`,
        };
    }

    const minLength = tightest(definers, "minLength");
    const maxLength = tightest(definers, "maxLength");

    if (minLength !== undefined && maxLength !== undefined && minLength.value > maxLength.value) {
        return {
            ok: false,
            reason:
                `${minLength.label} requires ${name} to be at least ${minLength.value} characters long, and ${maxLength.label} requires it to be ` +
                `at most ${maxLength.value} characters long, so no answer fits both.`,
        };
    }

    const patterns = [...new Set(definers.flatMap((entry) => (entry.definition.validate?.pattern === undefined ? [] : [entry.definition.validate.pattern])))];
    const validate: VariableValidation = {
        ...(first.definition.validate ?? {}),
        ...(options === undefined ? {} : { enum: options }),
        ...(min === undefined ? {} : { min: min.value }),
        ...(max === undefined ? {} : { max: max.value }),
        ...(minLength === undefined ? {} : { minLength: minLength.value }),
        ...(maxLength === undefined ? {} : { maxLength: maxLength.value }),
        ...(patterns[0] === undefined ? {} : { pattern: patterns[0] }),
    };

    // A declared env name is kept only when every definition declares the same one; otherwise the
    // answer is stored under the shared name, which every definition reads.
    const envs = new Set(definers.map((entry) => entry.definition.env));
    const rest: VariableDefinition = { ...first.definition };

    delete rest.default;
    delete rest.env;

    const combined: AnswerDefinition = {
        ...rest,
        ...(envs.size === 1 && first.definition.env !== undefined ? { env: first.definition.env } : {}),
        secret: definers.some((entry) => entry.definition.secret),
        scope: definers.some((entry) => entry.definition.scope === "local") ? "local" : "shared",
        required: definers.some((entry) => entry.definition.required),
        ...(Object.keys(validate).length === 0 ? {} : { validate }),
        ...(patterns.length > 1 ? { patterns } : {}),
    };

    const fallback = definers.map((entry) => entry.definition.default).find((value) => value !== undefined && validateAnswer(combined, String(value)).ok);

    return { ok: true, definition: fallback === undefined ? combined : { ...combined, default: fallback } };
}

/** A type name with its article: "a number", "an enum". */
function article(type: string): string {
    return /^[aeiou]/.test(type) ? `an ${type}` : `a ${type}`;
}
