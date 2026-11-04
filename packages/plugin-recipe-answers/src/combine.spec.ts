import type { VariableDefinition } from "@sous-io/plugin-formats/types";
import { describe, expect, it } from "vitest";
import { definition } from "../test/stand-ins.js";
import { combineDefinitions, type Definer } from "./combine.js";
import { validateAnswer } from "./validate.js";

/** Two definers, `misc/stuff` then `misc/other`. */
function pair(first: Partial<VariableDefinition>, second: Partial<VariableDefinition>): Definer[] {
    return [
        { label: "misc/stuff", definition: definition(first) },
        { label: "misc/other", definition: definition(second) },
    ];
}

/** The combined definition, failing the test when there is none. */
function combined(definers: Definer[]) {
    const result = combineDefinitions(definers);

    if (!result.ok) {
        throw new Error(`expected a combination, got: ${result.reason}`);
    }

    return result.definition;
}

describe("combineDefinitions()", () => {
    /**
     * A single definition should come back unchanged.
     *
     * combineDefinitions([{ label: "misc/stuff", definition }]);
     * // -> { ok: true, definition } (the same object)
     */
    it("should return a single definition unchanged", () => {
        const only = definition();

        expect(combineDefinitions([{ label: "misc/stuff", definition: only }])).toEqual({ ok: true, definition: only });
    });

    /**
     * The combination should be secret when any definition is, local when any is local, and
     * required when any is required.
     *
     * combineDefinitions(pair({ required: false }, { secret: true, scope: "local", required: true }));
     * // -> { secret: true, scope: "local", required: true, ... }
     */
    it("should take secret, local and required from any definition", () => {
        expect(combined(pair({ required: false }, { secret: true, scope: "local", required: true }))).toMatchObject({ secret: true, scope: "local", required: true });
        expect(combined(pair({ scope: "local", required: false }, { required: false }))).toMatchObject({ secret: false, scope: "local", required: false });
    });

    /**
     * The prompt, description and example should be the first definition's.
     *
     * combineDefinitions(pair({ prompt: "First?" }, { prompt: "Second?" })).definition.prompt;
     * // -> "First?"
     */
    it("should keep the first definition's prompt, description and example", () => {
        const result = combined(pair({ prompt: "First?", description: "One.", example: "a" }, { prompt: "Second?", description: "Two.", example: "b" }));

        expect(result).toMatchObject({ prompt: "First?", description: "One.", example: "a" });
    });

    /**
     * The enum options should be the ones every definition lists, in the first list's order.
     *
     * { enum: [a, b, c] } with { enum: [c, b] }  // -> { enum: [b, c] }
     */
    it("should keep only the enum options every definition accepts", () => {
        const result = combined(pair({ type: "enum", validate: { enum: ["a", "b", "c"] } }, { type: "enum", validate: { enum: ["c", "b"] } }));

        expect(result.validate?.enum).toEqual(["b", "c"]);
    });

    /**
     * The numeric range should be the highest min and the lowest max.
     *
     * { min: 10, max: 100 } with { min: 20, max: 50 }  // -> { min: 20, max: 50 }
     */
    it("should take the highest min and the lowest max", () => {
        const result = combined(pair({ type: "number", validate: { min: 10, max: 100 } }, { type: "number", validate: { min: 20, max: 50 } }));

        expect(result.validate).toEqual({ min: 20, max: 50 });
    });

    /**
     * The length range should be the highest minLength and the lowest maxLength.
     *
     * { minLength: 2 } with { minLength: 4, maxLength: 8 }  // -> { minLength: 4, maxLength: 8 }
     */
    it("should take the highest minLength and the lowest maxLength", () => {
        const result = combined(pair({ validate: { minLength: 2 } }, { validate: { minLength: 4, maxLength: 8 } }));

        expect(result.validate).toEqual({ minLength: 4, maxLength: 8 });
    });

    /**
     * Every pattern should apply: an answer must match each one.
     *
     * { pattern: "^https" } with { pattern: "\\.com$" }
     * // -> validateAnswer(combined, "https://x.com") passes; "https://x.org" fails
     */
    it("should require an answer to match every pattern", () => {
        const result = combined(pair({ validate: { pattern: "^https" } }, { validate: { pattern: "\\.com$" } }));

        expect(result.patterns).toEqual(["^https", "\\.com$"]);
        expect(validateAnswer(result, "https://x.com").ok).toBe(true);
        expect(validateAnswer(result, "https://x.org")).toEqual({ ok: false, message: "apiUrl must match the pattern \\.com$." });
        expect(validateAnswer(result, "http://x.com")).toEqual({ ok: false, message: "apiUrl must match the pattern ^https." });
    });

    /**
     * A default should be kept only when it passes the combination; the first that passes wins.
     *
     * { default: 5 } with { min: 10, default: 20 }  // -> default 20
     * { default: 5 } with { min: 10 }               // -> no default
     */
    it("should drop a default that fails the combination", () => {
        expect(combined(pair({ type: "number", default: 5 }, { type: "number", validate: { min: 10 }, default: 20 })).default).toBe(20);
        expect(combined(pair({ type: "number", default: 5 }, { type: "number", validate: { min: 10 } })).default).toBeUndefined();
        expect(combined(pair({ type: "number", default: 15 }, { type: "number", validate: { min: 10 } })).default).toBe(15);
    });

    /**
     * A declared env name should be kept only when every definition declares the same one, so the
     * answer is stored where every definition reads it.
     *
     * { env: "API_URL" } with { env: "API_URL" }  // -> env "API_URL"
     * { env: "API_URL" } with {}                  // -> no env (the shared name)
     */
    it("should keep a declared env name only when every definition agrees", () => {
        expect(combined(pair({ env: "API_URL" }, { env: "API_URL" })).env).toBe("API_URL");
        expect(combined(pair({ env: "API_URL" }, {})).env).toBeUndefined();
    });

    /**
     * Different types cannot be combined; the reason names both definitions.
     *
     * { type: "number" } with { type: "string" }
     * // -> { ok: false, reason: "misc/stuff defines apiUrl as a number, and misc/other defines it as a string, so no answer fits both." }
     */
    it("should refuse different types, naming both definitions", () => {
        expect(combineDefinitions(pair({ type: "number" }, { type: "string" }))).toEqual({
            ok: false,
            reason: "misc/stuff defines apiUrl as a number, and misc/other defines it as a string, so no answer fits both.",
        });
    });

    /**
     * Enum lists with no option in common cannot be combined.
     *
     * { enum: [a, b] } with { enum: [c] }
     * // -> { ok: false, reason: "No value of apiUrl is accepted by every definition (misc/stuff accepts a, b; misc/other accepts c)." }
     */
    it("should refuse enum lists with no shared option", () => {
        expect(combineDefinitions(pair({ type: "enum", validate: { enum: ["a", "b"] } }, { type: "enum", validate: { enum: ["c"] } }))).toEqual({
            ok: false,
            reason: "No value of apiUrl is accepted by every definition (misc/stuff accepts a, b; misc/other accepts c).",
        });
    });

    /**
     * An empty numeric range cannot be combined.
     *
     * { min: 10 } with { max: 5 }
     * // -> { ok: false, reason: "misc/stuff requires apiUrl to be at least 10, and misc/other requires it to be at most 5, so no answer fits both." }
     */
    it("should refuse an empty numeric range", () => {
        expect(combineDefinitions(pair({ type: "number", validate: { min: 10 } }, { type: "number", validate: { max: 5 } }))).toEqual({
            ok: false,
            reason: "misc/stuff requires apiUrl to be at least 10, and misc/other requires it to be at most 5, so no answer fits both.",
        });
    });

    /** An empty length range cannot be combined either. */
    it("should refuse an empty length range", () => {
        const result = combineDefinitions(pair({ validate: { minLength: 9 } }, { validate: { maxLength: 3 } }));

        expect(result.ok).toBe(false);
    });
});
