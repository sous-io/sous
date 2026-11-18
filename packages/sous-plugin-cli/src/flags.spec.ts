import { toJsonSchema } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { argumentsFromSchema, convertValue } from "./flags.js";

describe("argumentsFromSchema()", () => {
    /**
     * Every input field becomes a flag, in kebab case, with its kind, description, default
     * and choices from the JSON Schema.
     *
     * z.object({ installPlugins: z.boolean().default(false) })  ->  --install-plugins (boolean)
     */
    it("should make one flag per input field, from a zod schema", () => {
        const schema = toJsonSchema(
            z.object({
                ref: z.string().describe("The recipe"),
                installPlugins: z.boolean().default(false),
                count: z.number().optional(),
                level: z.number().int().default(1),
                tags: z.array(z.string()),
                mode: z.enum(["a", "b"]),
                options: z.object({ x: z.string() }).optional(),
                maybe: z.string().nullable().optional(),
            }),
        );
        const { flags, positionals } = argumentsFromSchema(schema);

        expect(positionals).toEqual([]);
        expect(flags.map((flag) => [flag.name, flag.kind, flag.multiple, flag.required])).toEqual([
            ["ref", "string", false, true],
            ["install-plugins", "boolean", false, false],
            ["count", "number", false, false],
            ["level", "integer", false, false],
            ["tags", "string", true, true],
            ["mode", "string", false, true],
            ["options", "json", false, false],
            ["maybe", "string", false, false],
        ]);
        expect(flags[0]!.description).toBe("The recipe");
        expect(flags[3]!.defaultValue).toBe(1);
        expect(flags[5]!.choices).toEqual(["a", "b"]);
    });

    /**
     * `cli.positional` names fields given as positional arguments, in order; the last array field
     * takes every remaining argument. Short flags, aliases and hidden flags come from `cli.flags`.
     */
    it("should read positional arguments and flag options from the cli section", () => {
        const schema = toJsonSchema(z.object({ repo: z.string(), urls: z.array(z.string()), yes: z.boolean().default(false) }));
        const { flags, positionals } = argumentsFromSchema(schema, {
            positional: ["repo", "urls"],
            flags: { yes: { short: "y", aliases: ["force"], hidden: true } },
        });

        expect(positionals.map((spec) => [spec.name, spec.variadic, spec.required])).toEqual([
            ["repo", false, true],
            ["urls", true, true],
        ]);
        expect(flags.find((flag) => flag.field === "yes")).toMatchObject({ short: "y", aliases: ["force"], hidden: true });
    });

    /** A positional naming no schema field is still listed, as text. Enums of numbers parse as numbers. */
    it("should handle unknown positional fields, number enums and untyped fields", () => {
        const { flags, positionals } = argumentsFromSchema(
            {
                type: "object",
                properties: { size: { enum: [1, 2] }, anything: {}, list: { type: "array" }, either: { anyOf: [{ type: "null" }, { type: "integer" }] } },
            },
            { positional: ["missing"] },
        );

        expect(positionals[0]).toMatchObject({ name: "missing", kind: "string", required: false });
        expect(flags.map((flag) => [flag.name, flag.kind, flag.multiple])).toEqual([
            ["size", "number", false],
            ["anything", "string", false],
            ["list", "string", true],
            ["either", "integer", false],
        ]);
    });

    /** No schema means no flags. */
    it("should give no flags without a schema", () => {
        expect(argumentsFromSchema(undefined)).toEqual({ flags: [], positionals: [] });
    });
});

describe("convertValue()", () => {
    /**
     * convertValue turns command-line text into a value of the flag's kind, or a message naming
     * the flag.
     *
     * convertValue("3", "integer", "--priority"); // -> { value: 3 }
     */
    it("should convert each kind, and explain what it cannot convert", () => {
        expect(convertValue("3", "integer", "--n")).toEqual({ value: 3 });
        expect(convertValue("2.5", "number", "--n")).toEqual({ value: 2.5 });
        expect(convertValue("2.5", "integer", "--n")).toEqual({ error: '--n takes a whole number, not "2.5".' });
        expect(convertValue("x", "number", "--n")).toEqual({ error: '--n takes a number, not "x".' });
        expect(convertValue(" ", "number", "--n")).toEqual({ error: '--n takes a number, not " ".' });
        expect(convertValue('{"a":1}', "json", "--o")).toEqual({ value: { a: 1 } });
        expect(convertValue("{", "json", "--o")).toEqual({ error: '--o takes JSON, and "{" is not valid JSON.' });
        expect(convertValue("true", "boolean", "--b")).toEqual({ value: true });
        expect(convertValue("no", "boolean", "--b")).toEqual({ value: false });
        expect(convertValue("text", "string", "--s")).toEqual({ value: "text" });
    });
});
