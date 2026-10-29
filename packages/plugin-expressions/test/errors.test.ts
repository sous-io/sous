/**
 * S5, "Errors": each fails the load as a `ConfigError` naming the file the expression came from
 * and its key path.
 */

import { ConfigError, isSousErrorOfKind } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { ExpressionError } from "../src/errors.js";
import { answersSource, evaluate, jsLanguage, makeEvaluator } from "./helpers.js";
import { createLiquidLanguage } from "../src/liquid-language.js";

const FILE = "conf.d/610-team.jsonc";

/** The error evaluating data throws. */
function failure(data: unknown, options: Parameters<typeof evaluate>[1] = {}): ExpressionError {
    try {
        evaluate(data, { file: FILE, ...options });
    } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect(isSousErrorOfKind(error, "config")).toBe(true);
        expect((error as ExpressionError).details[0]).toBe(`in ${FILE}`);

        return error as ExpressionError;
    }

    throw new Error("expected the evaluation to fail");
}

describe("1. a reserved key mixed with an unreserved one", () => {
    it("names the file, the key path and the stray key (a typo like $iff)", () => {
        const error = failure({ subscriptions: { "x/y": { enabled: { $if: "true", $iff: "false" } } } });

        expect(error.path).toBe('subscriptions."x/y".enabled');
        expect(error.file).toBe(FILE);
        expect(error.message).toContain('"$iff"');
        expect(error.message).toContain('"$if"');
    });

    it("refuses $schema next to an expression key", () => {
        expect(failure({ v: { $expr: "1", $schema: "x" } }).message).toContain('"$schema"');
    });

    it("refuses $expr together with $if, and two $expr keys", () => {
        expect(failure({ v: { $expr: "1", $if: "true" } }).message).toContain("$expr");
        expect(failure({ v: { $expr: "1", "$expr:liquid": "2" } }).message).toContain('"$expr:liquid"');
    });

    it("finds a mix inside an array item", () => {
        expect(failure({ list: [1, { $else: 1, other: 2 }] }).path).toBe("list[1]");
    });
});

describe("2. an unknown key, or both spellings of one key, in a branch block", () => {
    it("refuses an unknown key", () => {
        const error = failure({ v: { $if: { expr: "true", then: 1, else: 2 } } });

        expect(error.path).toBe('v.$if');
        expect(error.message).toContain('"else"');
    });

    it("refuses expr together with $expr", () => {
        expect(failure({ v: { $if: { expr: "true", $expr: "true" } } }).message).toContain('"expr" and "$expr"');
    });

    it("refuses then together with $then", () => {
        expect(failure({ v: { $if: { expr: "true", then: 1, $then: 2 } } }).message).toContain('"then" and "$then"');
    });

    it("refuses two expressions with different qualifiers", () => {
        expect(failure({ v: { $elseif: { expr: "true", "expr:liquid": "true" } } }).path).toBe('v.$elseif');
    });

    it("refuses a block with no expr outside an array, an empty block, and a branch of the wrong type", () => {
        expect(failure({ v: { $if: { then: 1 } } }).message).toContain("no expr");
        expect(failure({ v: { $if: [{}] } }).message).toContain("empty branch block");
        expect(failure({ v: { $if: 5 } }).message).toContain("A branch is a string");
        expect(failure({ v: { $if: { expr: 5 } } }).message).toContain("An expression is a string");
        expect(failure({ v: { $expr: true } }).message).toContain("An expression is a string");
    });
});

describe("3. a fallback that is not last, or a fallback together with an $else", () => {
    it("refuses a fallback that is not the last item", () => {
        const error = failure({ v: { $if: [{ then: 1 }, { expr: "true", then: 2 }] } });

        expect(error.path).toBe('v.$if[0]');
        expect(error.message).toContain("last item of the last key");
    });

    it("refuses a fallback in a key that is not the last of the chain", () => {
        expect(failure({ v: { $if: [{ then: 1 }], $elseif: "true" } }).path).toBe('v.$if[0]');
        expect(failure({ v: { $if: [{ then: 1 }], "$if:z": "true" } }).path).toBe('v.$if[0]');
    });

    it("refuses a fallback together with an $else", () => {
        expect(failure({ v: { $if: [{ expr: "false", then: 1 }, { then: 2 }], $else: 3 } }).message).toContain("$else");
    });
});

describe("4. an empty qualifier, or an unknown language", () => {
    it("refuses an empty name after $if: and $elseif:", () => {
        expect(failure({ v: { "$if:": "true" } }).path).toBe('v."$if:"');
        expect(failure({ v: { "$elseif:": "true" } }).message).toContain("empty qualifier");
    });

    it("refuses an empty language after $expr: and expr:", () => {
        expect(failure({ v: { "$expr:": "1" } }).message).toContain("empty language");
        expect(failure({ v: { $if: { "expr:": "1" } } }).path).toBe('v.$if."expr:"');
    });

    it("refuses an unknown language, naming it and the languages sous knows", () => {
        const error = failure({ v: { "$expr:python": "1" } });

        expect(error.path).toBe('v."$expr:python"');
        expect(error.message).toContain('"python"');
        expect(error.message).toContain("Known languages: liquid.");
    });

    it("refuses an unknown language inside a branch", () => {
        expect(failure({ v: { $if: { "expr:js": "true", then: 1 } } }).message).toContain('"js"');
    });
});

describe("5. an expression Liquid cannot parse, or one that fails while evaluating", () => {
    it("refuses one that cannot parse", () => {
        const error = failure({ v: { $if: "x[" } });

        expect(error.path).toBe('v.$if');
        expect(error.message).toContain('"x["');
    });

    it("refuses one that fails while evaluating", () => {
        expect(failure({ v: { $expr: "'a' | append: 1, 2, 3" } }).message).toContain("failed");
    });

    it("refuses a plugin filter that throws", () => {
        const boom = { id: "boom", filter: () => () => { throw new Error("kaboom"); } };

        expect(failure({ v: { $expr: "1 | boom" } }, { entities: { "liquid-filter": [boom] } }).message).toContain("kaboom");
    });
});

describe("6. a variable still unknown when the load settles", () => {
    it("gives undefined for the pass, then fails once settled, naming the variable", () => {
        const evaluator = makeEvaluator();
        const result = evaluate({ subscriptions: { x: { enabled: { $if: "machineRole == 'laptop'" } } } }, { evaluator, file: FILE });

        expect(result.value).toEqual({ subscriptions: { x: {} } });
        expect(result.pending).toBe(true);
        expect(evaluator.unsettled()).toEqual([{ file: FILE, path: "subscriptions.x.enabled", unknown: { variables: ["machineRole"], filters: [] } }]);
        expect(() => evaluator.settle()).toThrow(/subscriptions\.x\.enabled reads machineRole, which is not set/);

        try {
            evaluator.settle();
        } catch (error) {
            expect((error as ExpressionError).details[0]).toBe(`in ${FILE}`);
        }
    });

    it("names every unsettled expression, the rest in the details", () => {
        const evaluator = makeEvaluator();

        evaluate({ a: { $expr: "one" }, b: { $expr: "two" } }, { evaluator, file: FILE });

        try {
            evaluator.settle();
            throw new Error("expected settle to fail");
        } catch (error) {
            expect((error as ExpressionError).path).toBe("a");
            expect((error as ExpressionError).details).toEqual([`in ${FILE}`, `b reads two, which is not set anywhere in the config (in ${FILE})`]);
        }
    });

    it("settles quietly once the variable is set, and starts the next build fresh", () => {
        const evaluator = makeEvaluator();

        evaluate({ a: { $expr: "role" } }, { evaluator, file: FILE });
        evaluate({ a: { $expr: "role" } }, { evaluator, file: FILE, config: { _vars: { role: "ci" } } });
        expect(() => evaluator.settle()).not.toThrow();

        evaluate({ b: { $expr: "1" } }, { evaluator, file: "other.jsonc" });
        expect(evaluator.evaluations().map((record) => record.path)).toEqual(["b"]);
    });
});

describe("8. an expression under subscriptions or repos that reads a recipe answer", () => {
    const entities = { "variable-source": [answersSource({ githubProjectId: "42" }) as never] };

    it("fails with S2's message", () => {
        const error = failure(
            { subscriptions: { "workflow/github-projects": { enabled: { $if: "githubProjectId != ''" } } } },
            { entities, config: { _vars: { githubProjectId: "42" } } },
        );

        expect(error.message).toBe(
            'subscriptions."workflow/github-projects".enabled reads githubProjectId, which is an answer to a recipe. ' +
                'An expression that decides which recipes are subscribed or pinned (anything under "subscriptions" or "repos") cannot read recipe answers.',
        );
    });

    it("fails under repos too", () => {
        expect(failure({ repos: { r: { $expr: "githubProjectId" } } }, { entities }).path).toBe("repos.r");
    });

    it("allows reading answers everywhere else", () => {
        const result = evaluate({ recipes: { x: { $expr: "githubProjectId" } } }, { entities, config: { _vars: { githubProjectId: "42" } } });

        expect(result.value).toEqual({ recipes: { x: "42" } });
    });

    it("names any other source by its description", () => {
        const source = { id: "s", description: "team values", variables: () => ({ team: "a" }), forbiddenUnder: ["tools"] };

        expect(failure({ tools: { $expr: "team" } }, { entities: { "variable-source": [source as never] } }).message).toContain("team values");
    });
});

describe("recipe config files", () => {
    it("refuse a language that runs code", () => {
        const entities = { "expression-language": [createLiquidLanguage() as never, jsLanguage() as never] };
        const error = failure({ v: { "$expr:js": "1 + 1" } }, { entities, fromRecipe: true });

        expect(error.message).toContain("runs code");
        expect(error.message).toContain("(liquid)");
    });

    it("allow Liquid", () => {
        expect(evaluate({ v: { $expr: "1" } }, { fromRecipe: true }).value).toEqual({ v: 1 });
    });

    it("leave a code-running language allowed in the user's own files", () => {
        const entities = { "expression-language": [createLiquidLanguage() as never, jsLanguage() as never] };

        expect(evaluate({ v: { "$expr:js": "1 + 1" } }, { entities }).value).toEqual({ v: 2 });
    });
});
