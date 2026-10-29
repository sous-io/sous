/**
 * S5's rules and examples, one by one: expression objects, branch forms, arrays, qualifiers and
 * order, results, dropping, truth, `$else`, nesting and depth.
 */

import { describe, expect, it } from "vitest";
import { evaluate, valueOf } from "./helpers.js";

describe("expression objects", () => {
    it("replaces an expression object with its result", () => {
        expect(valueOf({ enabled: { $if: "host.platform != 'win32'" } })).toEqual({ enabled: true });
    });

    it("leaves an object with other $ keys alone: only the exact reserved list counts", () => {
        const data = { $schema: "https://example.com/schema.json", other: { $ref: "#/x", $comment: "kept" } };

        expect(valueOf(data)).toEqual(data);
    });

    it.each(["$expr", "$expr:liquid", "$if", "$if:a", "$elseif", "$elseif:b", "$else"])("treats %s as reserved", (key) => {
        const value = key.startsWith("$expr") ? "'x'" : key === "$else" ? "x" : "true";

        expect(valueOf({ v: { [key]: value } })).toEqual({ v: key.startsWith("$expr") || key === "$else" ? "x" : true });
    });

    it("accepts expressions at any depth, including array items", () => {
        const data = {
            a: { b: { c: [1, { $expr: "2 | plus: 1" }, { d: { $if: "true", $else: false } }] } },
        };

        expect(valueOf(data)).toEqual({ a: { b: { c: [1, 3, { d: true }] } } });
    });

    it("evaluates a whole file that is itself an expression object", () => {
        expect(valueOf({ $if: { expr: "true", then: { a: 1 } } })).toEqual({ a: 1 });
    });
});

describe("$expr: a computed value", () => {
    it("uses the result as it is: a string stays a string", () => {
        expect(valueOf({ label: { $expr: "host.platform | upcase" } })).toEqual({ label: "LINUX" });
    });

    it("keeps numbers, booleans and arrays", () => {
        expect(valueOf({ n: { $expr: "2 | times: 3" }, b: { $expr: "1 > 2" }, a: { $expr: "'a,b' | split: ','" } })).toEqual({
            n: 6,
            b: false,
            a: ["a", "b"],
        });
    });

    it("accepts the language qualifier", () => {
        expect(valueOf({ enabled: { "$expr:liquid": "host.platform != 'win32'" } })).toEqual({ enabled: true });
    });

    it("drops the key when the result is undefined, and gives null for nil", () => {
        expect(valueOf({ gone: { $expr: "host.nothing" }, none: { $expr: "nil" } })).toEqual({ none: null });
    });

    it("reads env values", () => {
        expect(valueOf({ ci: { $expr: "env.CI" } }, { env: { CI: "true" } })).toEqual({ ci: "true" });
    });
});

describe("the forms of one branch (S5 a to e)", () => {
    const forms = {
        a: { $if: "host.platform != 'win32'" },
        b: { $if: { expr: "host.platform != 'win32'" } },
        c: { $if: { expr: "host.platform != 'win32'", then: "bar" } },
        d: { $if: { $expr: "host.platform != 'win32'", $then: "bar" } },
        e: { $if: { "expr:liquid": "host.platform != 'win32'", then: "bar" } },
    };

    it("gives true for a condition alone (a, b), and the then value with one (c, d, e)", () => {
        expect(valueOf(forms)).toEqual({ a: true, b: true, c: "bar", d: "bar", e: "bar" });
    });

    it("accepts $expr:<language> inside a block", () => {
        expect(valueOf({ v: { $if: { "$expr:liquid": "true", then: 1 } } })).toEqual({ v: 1 });
    });

    it("accepts every form under $elseif", () => {
        const data = Object.fromEntries(Object.entries(forms).map(([key, value]) => [key, { $elseif: value.$if }]));

        expect(valueOf(data)).toEqual({ a: true, b: true, c: "bar", d: "bar", e: "bar" });
    });

    it("gives undefined on Windows for every form, so every key is dropped", () => {
        expect(valueOf(forms, { platform: "win32" })).toEqual({});
    });
});

describe("arrays", () => {
    const data = {
        foo: {
            $if: [
                { expr: "host.platform == 'win32'", then: "bar" },
                { expr: "host.platform == 'linux'", then: "barx" },
            ],
            $else: "bad",
        },
    };

    it("tries each item in array order (S5's example)", () => {
        expect(valueOf(data, { platform: "linux" })).toEqual({ foo: "barx" });
        expect(valueOf(data, { platform: "win32" })).toEqual({ foo: "bar" });
        expect(valueOf(data, { platform: "darwin" })).toEqual({ foo: "bad" });
    });

    it("accepts an array under $elseif, and items in any form", () => {
        const mixed = { v: { $if: "false", $elseif: ["false", { $expr: "false" }, { expr: "true", $then: "third" }] } };

        expect(valueOf(mixed)).toEqual({ v: "third" });
    });

    it("uses a last item with no expr as the fallback", () => {
        const fallback = { v: { $if: [{ expr: "host.platform == 'win32'", then: "win" }, { then: "other" }] } };

        expect(valueOf(fallback, { platform: "linux" })).toEqual({ v: "other" });
        expect(valueOf(fallback, { platform: "win32" })).toEqual({ v: "win" });
    });

    it("allows a fallback in the last key of the chain", () => {
        const data2 = { v: { "$if:a": "false", $elseif: [{ expr: "false", then: 1 }, { then: 2 }] } };

        expect(valueOf(data2)).toEqual({ v: 2 });
    });

    it("gives undefined for an empty array of branches", () => {
        expect(valueOf({ v: { $if: [] } })).toEqual({});
    });
});

describe("qualifiers and order", () => {
    it("tries $if, then $if:<name> in name order, then $elseif, then $elseif:<name>, then $else", () => {
        // Each run makes every branch from one place in the order onward true; the first true one
        // wins. Keys are written in reverse order, which must not matter.
        const order = ["if", "if:a", "if:b", "elseif", "elseif:a", "elseif:b"];

        for (let index = 0; index <= order.length; index++) {
            const object: Record<string, unknown> = { $else: "else" };

            for (const [position, name] of [...order.entries()].reverse()) {
                object[`$${name}`] = { expr: position >= index ? "true" : "false", then: name };
            }

            expect(valueOf({ v: object })).toEqual({ v: order[index] ?? "else" });
        }
    });

    it("sorts names bytewise: $if:10 comes before $if:2, and $if:02 before $if:10", () => {
        expect(valueOf({ v: { "$if:2": { expr: "true", then: "two" }, "$if:10": { expr: "true", then: "ten" } } })).toEqual({ v: "ten" });
        expect(valueOf({ v: { "$if:10": { expr: "true", then: "ten" }, "$if:02": { expr: "true", then: "two" } } })).toEqual({ v: "two" });
    });

    it("sorts upper case before lower case, whatever the locale", () => {
        expect(valueOf({ v: { "$if:b": { expr: "true", then: "b" }, "$if:B": { expr: "true", then: "B" } } })).toEqual({ v: "B" });
    });

    it("reads a qualifier after $if: as a name, never a language", () => {
        expect(valueOf({ v: { "$if:liquid": { expr: "true", then: "named" } } })).toEqual({ v: "named" });
        expect(valueOf({ v: { "$if:js": "true" } })).toEqual({ v: true });
    });

    it("stops at the first true branch: no later branch is evaluated", () => {
        // A later branch that would fail to parse never runs.
        expect(valueOf({ v: { $if: "true", $elseif: "x[" } })).toEqual({ v: true });
    });

    it("gives the three outcomes of S5's qualifier example", () => {
        const data = {
            recipes: {
                skills: {
                    outputs: {
                        "$if:01-windows": { expr: "host.platform == 'win32'", then: ["C:/agents/skills"] },
                        "$if:02-mac": { expr: "host.platform == 'darwin'", then: ["~/Library/agents/skills"] },
                        $else: [".claude/skills"],
                    },
                },
            },
        };

        expect(valueOf(data, { platform: "win32" })).toEqual({ recipes: { skills: { outputs: ["C:/agents/skills"] } } });
        expect(valueOf(data, { platform: "darwin" })).toEqual({ recipes: { skills: { outputs: ["~/Library/agents/skills"] } } });
        expect(valueOf(data, { platform: "linux" })).toEqual({ recipes: { skills: { outputs: [".claude/skills"] } } });
    });
});

describe("what a chain gives", () => {
    it("1. a branch with a then gives its then value when true", () => {
        expect(valueOf({ v: { $if: { expr: "true", then: { a: 1 } } } })).toEqual({ v: { a: 1 } });
    });

    it("2. a branch with no then gives true when true", () => {
        expect(valueOf({ v: { $if: { expr: "true" } } })).toEqual({ v: true });
    });

    it("3. no true condition: the $else value, or undefined (dropped) whether or not branches have a then", () => {
        expect(valueOf({ v: { $if: "false", $else: "else" } })).toEqual({ v: "else" });
        expect(valueOf({ v: { $if: "false" } })).toEqual({});
        expect(valueOf({ v: { $if: { expr: "false", then: "x" } } })).toEqual({});
    });

    it("3. the 610-linux-only example: true on Linux, dropped elsewhere so the 510 value stands", () => {
        const data = { subscriptions: { "tool-usage/automated-browser-tasks": { enabled: { $if: "host.platform == 'linux'" } } } };

        expect(valueOf(data, { platform: "linux" })).toEqual({ subscriptions: { "tool-usage/automated-browser-tasks": { enabled: true } } });
        expect(valueOf(data, { platform: "darwin" })).toEqual({ subscriptions: { "tool-usage/automated-browser-tasks": {} } });
    });

    it("3. switches the subscription off elsewhere with \"$else\": false", () => {
        const data = { enabled: { $if: "host.platform == 'linux'", $else: false } };

        expect(valueOf(data, { platform: "darwin" })).toEqual({ enabled: false });
    });

    it("4. an object holding only $else gives its value", () => {
        expect(valueOf({ v: { $else: [1, 2] } })).toEqual({ v: [1, 2] });
    });

    it("5. an $elseif with no $if is simply the first branch", () => {
        expect(valueOf({ v: { $elseif: { expr: "true", then: "first" }, $else: "no" } })).toEqual({ v: "first" });
        expect(valueOf({ v: { "$elseif:z": "false", $else: "no" } })).toEqual({ v: "no" });
    });
});

describe("undefined is dropped; empty objects are kept", () => {
    it("drops the key whose value comes out undefined, and keeps the empty object around it (the 510 example)", () => {
        const data = {
            subscriptions: {
                "tool-usage/automated-browser-tasks": {
                    enabled: { $if: { expr: "host.platform == 'win32'", then: false } },
                },
            },
        };

        expect(valueOf(data, { platform: "linux" })).toEqual({ subscriptions: { "tool-usage/automated-browser-tasks": {} } });
        expect(valueOf(data, { platform: "win32" })).toEqual({ subscriptions: { "tool-usage/automated-browser-tasks": { enabled: false } } });
    });

    it("keeps an empty object given as a value", () => {
        expect(valueOf({ v: { $if: { expr: "true", then: {} } }, w: {} })).toEqual({ v: {}, w: {} });
    });

    it("drops an array item whose expression gives undefined", () => {
        expect(valueOf({ list: ["a", { $if: "false" }, "c"] })).toEqual({ list: ["a", "c"] });
    });

    it("keeps null, false, 0 and the empty string", () => {
        expect(valueOf({ a: null, b: { $else: false }, c: { $expr: "0" }, d: { $expr: "''" } })).toEqual({ a: null, b: false, c: 0, d: "" });
    });
});

describe("truth and falsehood follow Liquid", () => {
    it.each([
        ["false", false],
        ["nil", false],
        ["host.missing", false],
        ["true", true],
        ["''", true],
        ["0", true],
        ["'false'", true],
    ])("treats %s as %s", (expression, truth) => {
        expect(valueOf({ v: { $if: expression, $else: "no" } })).toEqual({ v: truth ? true : "no" });
    });

    it("SKIP_BROWSER=false is TRUE as a bare condition: env values are strings", () => {
        expect(valueOf({ enabled: { $if: "env.SKIP_BROWSER" } }, { env: { SKIP_BROWSER: "false" } })).toEqual({ enabled: true });
    });

    it("comparing the string gives the intended result", () => {
        expect(valueOf({ enabled: { $if: "env.SKIP_BROWSER != 'true'" } }, { env: { SKIP_BROWSER: "false" } })).toEqual({ enabled: true });
        expect(valueOf({ enabled: { $if: "env.SKIP_BROWSER != 'true'" } }, { env: { SKIP_BROWSER: "true" } })).toEqual({});
    });

    it("an unset env variable is false, not unknown", () => {
        const result = evaluate({ enabled: { $if: "env.NOT_SET", $else: "off" } });

        expect(result.value).toEqual({ enabled: "off" });
        expect(result.pending).toBe(false);
    });

    it("supports and, or and filters in conditions", () => {
        expect(valueOf({ v: { $if: "host.platform == 'linux' and env.CI == 'true'" } }, { env: { CI: "true" } })).toEqual({ v: true });
        expect(valueOf({ v: { $if: "host.platform == 'win32' or env.CI == 'true'" } }, { env: { CI: "no" } })).toEqual({});
        expect(valueOf({ v: { $if: "host.platform | upcase | size" } })).toEqual({ v: true });
    });
});

describe("$else", () => {
    it("gives its value as written (S5's example)", () => {
        const data = { foo: { $if: { expr: "host.platform != 'win32'", then: "bar" }, $else: "bad" } };

        expect(valueOf(data, { platform: "linux" })).toEqual({ foo: "bar" });
        expect(valueOf(data, { platform: "win32" })).toEqual({ foo: "bad" });
    });

    it("has no { then } form: an object holding a then key is used as written", () => {
        expect(valueOf({ v: { $if: "false", $else: { then: "x" } } })).toEqual({ v: { then: "x" } });
    });

    it("uses a then value holding then and expr keys as written", () => {
        expect(valueOf({ v: { $if: { expr: "true", then: { expr: "1", then: 2 } } } })).toEqual({ v: { expr: "1", then: 2 } });
    });
});

describe("nesting", () => {
    const data = {
        recipes: {
            skills: {
                outputs: {
                    $if: {
                        expr: "host.platform == 'darwin'",
                        then: {
                            $if: { expr: "env.CI == 'true'", then: ["/tmp/ci-skills"] },
                            $else: ["~/Library/agents/skills"],
                        },
                    },
                    $else: [".claude/skills"],
                },
            },
        },
    };

    it("evaluates a then value that is itself an expression object (S5's example)", () => {
        const outputs = (platform: string, ci: string) => (valueOf(data, { platform, env: { CI: ci } }) as never as { recipes: { skills: { outputs: unknown } } }).recipes.skills.outputs;

        expect(outputs("darwin", "true")).toEqual(["/tmp/ci-skills"]);
        expect(outputs("darwin", "false")).toEqual(["~/Library/agents/skills"]);
        expect(outputs("linux", "true")).toEqual([".claude/skills"]);
    });

    it("evaluates an $else value and array items that are expression objects", () => {
        expect(valueOf({ v: { $if: "false", $else: { $expr: "'nested'" } } })).toEqual({ v: "nested" });
        expect(valueOf({ v: { $if: { expr: "true", then: [{ $expr: "1" }, { $if: "false" }, 3] } } })).toEqual({ v: [1, 3] });
    });

    it("evaluates expressions deep inside a chosen value", () => {
        expect(valueOf({ v: { $else: { a: { b: { $expr: "'deep'" } } } } })).toEqual({ v: { a: { b: "deep" } } });
    });

    it("never evaluates a branch that was not chosen, so it cannot fail the load", () => {
        const broken = { $expr: "x[" };

        expect(valueOf({ v: { $if: "true", $else: broken } })).toEqual({ v: true });
        expect(valueOf({ v: { $if: { expr: "false", then: broken }, $else: 1 } })).toEqual({ v: 1 });
        expect(valueOf({ v: { $if: { expr: "false", then: { $if: "x", stray: 1 } }, $else: 1 } })).toEqual({ v: 1 });
    });

    it("tracks reads inside a chosen nested branch", () => {
        const result = evaluate(
            { v: { $if: { expr: "true", then: { $expr: "machineRole" } } } },
            { config: { _vars: { machineRole: "laptop" } } },
        );

        expect(result.value).toEqual({ v: "laptop" });
        expect(result.expressions[0]!.reads).toEqual({ machineRole: "laptop" });
        expect(result.recorded.paths).toContain("_vars");
    });
});

describe("S5's full examples", () => {
    it("510-subscriptions: one subscription everywhere, another everywhere except Windows", () => {
        const data = {
            subscriptions: {
                "workflow/github-projects": { range: "^1.0.0" },
                "tool-usage/automated-browser-tasks": { range: "^2.1.0", enabled: { $if: "host.platform != 'win32'" } },
            },
        };

        expect(valueOf(data, { platform: "linux" })).toEqual({
            subscriptions: {
                "workflow/github-projects": { range: "^1.0.0" },
                "tool-usage/automated-browser-tasks": { range: "^2.1.0", enabled: true },
            },
        });
        expect(valueOf(data, { platform: "win32" })).toEqual({
            subscriptions: {
                "workflow/github-projects": { range: "^1.0.0" },
                "tool-usage/automated-browser-tasks": { range: "^2.1.0" },
            },
        });
    });

    it("forms 1 to 4 mean the same", () => {
        const data = {
            "form-1": { $if: { expr: "host.platform != 'win32'" } },
            "form-2": { $if: { "$expr:liquid": "host.platform != 'win32'" } },
            "form-3": { $if: { expr: "host.platform == 'win32'", then: false }, $else: true },
            "form-4": { $expr: "host.platform != 'win32'" },
        };

        expect(valueOf(data, { platform: "linux" })).toEqual({ "form-1": true, "form-2": true, "form-3": true, "form-4": true });
        // On Windows, forms 1 and 2 drop the key; forms 3 and 4 say false.
        expect(valueOf(data, { platform: "win32" })).toEqual({ "form-3": false, "form-4": false });
    });

    it("S2's Mac-only switch-off: false on a Mac, {} on Linux", () => {
        const data = {
            subscriptions: {
                "tool-usage/automated-browser-tasks": { enabled: { $if: { expr: "host.platform == 'darwin'", then: false } } },
            },
        };

        expect(valueOf(data, { platform: "darwin" })).toEqual({ subscriptions: { "tool-usage/automated-browser-tasks": { enabled: false } } });
        expect(valueOf(data, { platform: "linux" })).toEqual({ subscriptions: { "tool-usage/automated-browser-tasks": {} } });
    });
});
