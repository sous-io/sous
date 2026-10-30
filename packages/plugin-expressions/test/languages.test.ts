/**
 * Expression languages and what an expression can read: languages as entities, Liquid
 * filters plugins add, and variables by bare name with their scopes.
 */

import { describe, expect, it } from "vitest";
import { createLiquidLanguage } from "../src/liquid-language.js";
import type { ExpressionLanguageEntity } from "../src/types.js";
import { evaluate, filterEntity, makeEvaluator, valueOf } from "./helpers.js";

describe("languages", () => {
    it("Liquid is the default", () => {
        expect(valueOf({ v: { $expr: "'a' | upcase" } })).toEqual({ v: "A" });
    });

    it("a plugin adds a language as an entity, named by the qualifier", () => {
        const reverse: ExpressionLanguageEntity = {
            id: "reverse",
            variables: () => [],
            evaluate: (expression) => ({ value: [...expression].reverse().join("") }),
        };
        const entities = { "expression-language": [createLiquidLanguage() as never, reverse as never] };

        expect(valueOf({ a: { "$expr:reverse": "abc" }, b: { $if: { "expr:reverse": "x", then: 1 } } }, { entities })).toEqual({ a: "cba", b: 1 });
    });

    it("a language's unknowns make the expression pending", () => {
        const later: ExpressionLanguageEntity = { id: "later", variables: () => [], evaluate: () => ({ unknown: { variables: [], filters: ["f"] } }) };
        const result = evaluate({ v: { "$expr:later": "x" } }, { entities: { "expression-language": [later as never] } });

        expect(result.value).toEqual({});
        expect(result.pending).toBe(true);
    });

    it("reads the language list through the builder", () => {
        expect(evaluate({ v: { $expr: "1" } }).recorded.kinds).toContain("expression-language");
    });

    it("liquid lists the variables an expression reads without running it", () => {
        const ctx = { project: undefined, file: "f", path: "p" };

        expect(createLiquidLanguage().variables("machineRole == 'laptop' and host.platform | append: suffix", ctx)).toEqual([
            "machineRole",
            "host",
            "suffix",
        ]);
    });
});

describe("Liquid filters plugins add", () => {
    const isTruthy = filterEntity("is_truthy", (value) => value === "true" || value === "1");

    it("uses a filter a plugin adds", () => {
        const entities = { "liquid-filter": [isTruthy as never] };

        expect(valueOf({ enabled: { $if: "env.CI | is_truthy" } }, { entities, env: { CI: "1" } })).toEqual({ enabled: true });
        expect(valueOf({ enabled: { $if: "env.CI | is_truthy" } }, { entities, env: { CI: "false" } })).toEqual({});
    });

    it("leaves out a filter whose purposes exclude config expressions", () => {
        const templateOnly = { ...filterEntity("tpl_only", () => "x"), purposes: ["template"] };
        const result = evaluate({ v: { $expr: "1 | tpl_only" } }, { entities: { "liquid-filter": [templateOnly as never] } });

        expect(result.pending).toBe(true);
    });

    it("gives undefined for a filter not loaded yet, reads the filter list so the file re-runs, then works once it exists", () => {
        const evaluator = makeEvaluator();
        const first = evaluate({ enabled: { $if: "env.CI | is_truthy" } }, { evaluator, env: { CI: "1" } });

        expect(first.value).toEqual({});
        expect(first.pending).toBe(true);
        expect(first.recorded.kinds).toContain("liquid-filter");
        expect(first.expressions[0]!.unknown).toEqual({ variables: [], filters: ["is_truthy"] });
        expect(evaluator.unsettled()[0]!.unknown.filters).toEqual(["is_truthy"]);

        const second = evaluate({ enabled: { $if: "env.CI | is_truthy" } }, { evaluator, env: { CI: "1" }, entities: { "liquid-filter": [isTruthy as never] } });

        expect(second.value).toEqual({ enabled: true });
        expect(evaluator.unsettled()).toEqual([]);
    });

    it("fails once settled when the filter still does not exist, naming it", () => {
        const evaluator = makeEvaluator();

        evaluate({ enabled: { $if: "env.CI | is_truthy" } }, { evaluator });
        expect(() => evaluator.settle()).toThrow(/uses the Liquid filter is_truthy, which no plugin adds/);
    });

    it("still knows LiquidJS's own filters", () => {
        expect(valueOf({ v: { $expr: "'a b' | split: ' ' | size" } })).toEqual({ v: 2 });
    });
});

describe("what an expression can read", () => {
    it("host.platform", () => {
        expect(valueOf({ v: { $expr: "host.platform" } }, { platform: "darwin" })).toEqual({ v: "darwin" });
    });

    it("env.<NAME>, from the builder's environment", () => {
        expect(valueOf({ v: { $expr: "env.HOME" } }, { env: { HOME: "/home/x" } })).toEqual({ v: "/home/x" });
    });

    it("variables by bare name, recording each read through the builder", () => {
        const result = evaluate({ enabled: { $if: "machineRole == 'laptop'" } }, { config: { _vars: { machineRole: "laptop" } } });

        expect(result.value).toEqual({ enabled: true });
        expect(result.recorded.paths).toContain("_vars");
        expect(result.expressions).toEqual([
            { path: "enabled", written: { $if: "machineRole == 'laptop'" }, value: true, reads: { machineRole: "laptop" } },
        ]);
    });

    it("never reads variables for an expression that uses only host and env", () => {
        expect(evaluate({ v: { $if: "host.platform == 'linux'" } }).recorded.paths).toEqual([]);
    });

    it("the file's own plain root _vars", () => {
        expect(valueOf({ _vars: { role: "own" }, v: { $expr: "role" } })).toEqual({ _vars: { role: "own" }, v: "own" });
        expect(valueOf({ v: { $expr: "role" } }, { ownVars: { role: "given" } })).toEqual({ v: "given" });
    });

    it("the _vars of every level that contains it, inner values winning", () => {
        const data = {
            _vars: { a: "root", b: "root", c: "root" },
            compilation: {
                _vars: { b: "compilation", c: "compilation" },
                targets: [{ _vars: { c: "target" }, out: { $expr: "a | append: b | append: c" }, outputs: [{ _vars: { a: "output" }, v: { $expr: "a" } }] }],
            },
        };

        expect(valueOf(data)).toMatchObject({
            compilation: { targets: [{ out: "rootcompilationtarget", outputs: [{ v: "output" }] }] },
        });
    });

    it("only the root _vars under any other top-level key", () => {
        const data = { compilation: { _vars: { x: "inner" } }, subscriptions: { s: { $expr: "x" } } };
        const result = evaluate(data, { config: { _vars: { x: "root" } } });

        expect((result.value as { subscriptions: unknown }).subscriptions).toEqual({ s: "root" });
    });

    it("the config's compilation._vars under compilation", () => {
        expect(valueOf({ compilation: { v: { $expr: "x" } } }, { config: { _vars: { x: "root" }, compilation: { _vars: { x: "c" } } } })).toEqual({
            compilation: { v: "c" },
        });
    });
});

describe("the evaluator's other methods", () => {
    it("isExpressionObject and hasExpressions", () => {
        const evaluator = makeEvaluator();

        expect(evaluator.isExpressionObject({ $if: "x" })).toBe(true);
        expect(evaluator.isExpressionObject({ $schema: "x" })).toBe(false);
        expect(evaluator.isExpressionObject([{ $if: "x" }])).toBe(false);
        expect(evaluator.hasExpressions({ a: [{ b: { $else: 1 } }] })).toBe(true);
        expect(evaluator.hasExpressions({ a: [{ b: { $iff: 1 } }] })).toBe(false);
    });

    it("evaluations, by file and for every file", () => {
        const evaluator = makeEvaluator();

        evaluate({ a: { $expr: "1" } }, { evaluator, file: "one" });
        evaluate({ b: { $if: "false" } }, { evaluator, file: "two" });

        expect(evaluator.evaluations("one")).toEqual([{ path: "a", written: { $expr: "1" }, value: 1, reads: {} }]);
        expect(evaluator.evaluations().map((record) => [record.path, record.value])).toEqual([
            ["a", 1],
            ["b", undefined],
        ]);
    });

    it("records only the outermost expression object, with every read inside it", () => {
        const result = evaluate({ v: { $if: { expr: "a == '1'", then: { $expr: "b" } } } }, { config: { _vars: { a: "1", b: "2" } } });

        expect(result.expressions).toHaveLength(1);
        expect(result.expressions[0]!.reads).toEqual({ a: "1", b: "2" });
    });
});
