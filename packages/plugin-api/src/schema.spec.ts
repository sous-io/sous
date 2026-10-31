import { describe, expect, it } from "vitest";
import { formatIssuePath, isSchema, jsonSchema, toJsonSchema, validateWith, validateWithSync } from "./schema.js";

describe("jsonSchema()", () => {
    /**
     * A property that is missing and has no default is optional unless `required` names it.
     *
     * jsonSchema({ type: "object", properties: { short: { type: "string" } } }) accepts { id: "debug" }
     */
    it("should accept a missing optional property", () => {
        const schema = jsonSchema({ type: "object", properties: { id: { type: "string" }, short: { type: "string" } } });

        expect(validateWithSync(schema, { id: "debug" })).toEqual({ value: { id: "debug" } });
    });

    /**
     * Defaults fill in missing values, at the top and inside objects, as fresh copies.
     *
     * jsonSchema({ type: "boolean", default: false }) checks undefined → false
     */
    it("should fill in defaults", () => {
        const list: string[] = [];
        const schema = jsonSchema({ type: "object", properties: { load: { type: "array", items: { type: "string" }, default: list } } });
        const result = validateWithSync(schema, {});

        expect(validateWithSync(jsonSchema({ type: "boolean", default: false }), undefined)).toEqual({ value: false });
        expect(result).toEqual({ value: { load: [] } });
        expect((result.value as { load: string[] }).load).not.toBe(list);
    });

    /**
     * Each kind of check reports a plain message with the path of the problem.
     *
     * { type: "string" } against 3 → "Expected string, got number 3."
     */
    it("should report type, enum, const, required, unknown-key and anyOf problems with paths", () => {
        const schema = jsonSchema({
            type: "object",
            required: ["id"],
            additionalProperties: false,
            properties: {
                id: { type: "string" },
                level: { enum: ["debug", "info"] },
                kind: { const: "x" },
                size: { type: "integer" },
                items: { type: "array", items: { type: ["string", "null"] } },
                either: { anyOf: [{ type: "number" }, { const: false }] },
                nested: { type: "object", additionalProperties: { type: "number" } },
            },
        });

        expect(validateWithSync(schema, { level: "loud", kind: "y", size: 1.5, items: ["a", null, 3, [], {}], either: "no", nested: { a: "b" }, extra: 1 }).issues).toEqual([
            { path: "id", message: "Required, but missing." },
            { path: "level", message: 'Expected one of "debug", "info".' },
            { path: "kind", message: 'Expected "x".' },
            { path: "size", message: "Expected integer, got number 1.5." },
            { path: "items[2]", message: "Expected string or null, got number 3." },
            { path: "items[3]", message: "Expected string or null, got an array." },
            { path: "items[4]", message: "Expected string or null, got an object." },
            { path: "either", message: "Expected a value matching one of the allowed forms." },
            { path: "nested.a", message: "Expected number, got string \"b\"." },
            { path: "extra", message: "Not a known key." },
        ]);
        expect(validateWithSync(jsonSchema({ type: "number" }), Number.NaN).issues?.[0]?.message).toBe("Expected number, got number null.");
        expect(validateWithSync(jsonSchema({ type: "null" }), undefined).issues?.[0]?.message).toBe("Expected null, got nothing.");
        expect(validateWithSync(jsonSchema({ type: "string" }), null).issues?.[0]?.message).toBe("Expected string, got null.");
        expect(validateWithSync(jsonSchema({ type: "boolean" }), true)).toEqual({ value: true });
        expect(validateWithSync(jsonSchema({ anyOf: [{ type: "number" }, { const: false }] }), false)).toEqual({ value: false });
    });

    /**
     * The schema gives its JSON Schema back to front ends, and is recognized as a schema.
     */
    it("should describe itself as JSON Schema", () => {
        const source = { type: "boolean" as const, default: false, description: "Show more" };

        expect(toJsonSchema(jsonSchema(source))).toEqual(source);
        expect(jsonSchema(source)["~standard"]).toMatchObject({ version: 1, vendor: "sous" });
        expect(isSchema(jsonSchema(source))).toBe(true);
        expect(isSchema({})).toBe(false);
        expect(isSchema(null)).toBe(false);
    });
});

describe("toJsonSchema()", () => {
    /**
     * A schema without a converter, or whose converter throws, has no JSON Schema.
     */
    it("should return undefined when a schema cannot describe itself", () => {
        const plain = { "~standard": { version: 1 as const, vendor: "x", validate: (value: unknown) => ({ value }) } };
        const throwing = { "~standard": { ...plain["~standard"], jsonSchema: { input: () => { throw new Error("no"); }, output: () => ({}) } } };

        expect(toJsonSchema(undefined)).toBeUndefined();
        expect(toJsonSchema(plain)).toBeUndefined();
        expect(toJsonSchema(throwing)).toBeUndefined();
    });
});

describe("validateWith()", () => {
    /**
     * Asynchronous schemas are awaited; issue paths given as { key } segments are written as paths.
     */
    it("should await async schemas and format issue paths", async () => {
        const asyncSchema = {
            "~standard": {
                version: 1 as const,
                vendor: "x",
                validate: async () => ({ issues: [{ message: "bad", path: [{ key: "targets" }, 2, "id"] }, { message: "top" }] }),
            },
        };

        expect(await validateWith(asyncSchema, 1)).toEqual({ issues: [{ path: "targets[2].id", message: "bad" }, { path: "", message: "top" }] });
        expect(validateWithSync(asyncSchema, 1)).toEqual({ issues: [{ path: "", message: "This schema checks values asynchronously, which is not supported here." }] });
        expect(await validateWith(jsonSchema({ type: "string" }), "a")).toEqual({ value: "a" });
    });
});

describe("formatIssuePath()", () => {
    /**
     * Paths are written the way sous writes them: keys joined by dots, indexes in brackets, odd keys quoted.
     *
     * formatIssuePath(["subscriptions", "workflow/x", "enabled"]) → subscriptions."workflow/x".enabled
     */
    it("should write paths the sous way", () => {
        expect(formatIssuePath(["subscriptions", "workflow/x", "enabled"])).toBe('subscriptions."workflow/x".enabled');
        expect(formatIssuePath([0, "a"])).toBe("[0].a");
        expect(formatIssuePath([])).toBe("");
        expect(formatIssuePath([Symbol.for("s")])).toBe('"Symbol(s)"');
    });
});
