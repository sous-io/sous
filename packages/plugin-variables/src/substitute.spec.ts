import { isSousErrorOfKind, type SousError } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { normalizePath, references, substitute, substituteStrict, substituteValue, unresolved } from "./substitute.js";

/** The message and every detail line of an error, as a front end shows them. */
function shown(action: () => unknown): string {
    try {
        action();
    } catch (error) {
        const sous = error as SousError;

        return [sous.message, ...(sous.details ?? [])].join("\n");
    }

    throw new Error("expected an error");
}

describe("substitute()", () => {
    /**
     * Replaces one reference.
     *
     * substitute("Hello ${name}", { name: "world" });  // "Hello world"
     */
    it("should substitute a single variable reference", () => {
        expect(substitute("Hello ${name}", { name: "world" })).toBe("Hello world");
    });

    /** Replaces every reference, not just the first. */
    it("should substitute multiple variable references in one string", () => {
        expect(substitute("${a} and ${b}", { a: "foo", b: "bar" })).toBe("foo and bar");
        expect(substitute("${a}/x/${b}", { a: "/root", b: "y" })).toBe("/root/x/y");
    });

    /** Leaves an unknown reference as written. */
    it("should leave unknown variable references unchanged", () => {
        expect(substitute("value is ${missing}", {})).toBe("value is ${missing}");
        expect(substitute("${missing}/x", {})).toBe("${missing}/x");
    });

    /** Gives text with no references back unchanged. */
    it("should return the string unchanged when there are no references", () => {
        expect(substitute("no refs here", { a: "b" })).toBe("no refs here");
    });

    /** Replaces the known references and leaves the unknown ones in the same string. */
    it("should substitute known references and leave unknown ones as-is", () => {
        expect(substitute("${known} and ${unknown}", { known: "yes" })).toBe("yes and ${unknown}");
    });

    /**
     * A name like `toString` is only a variable when the scope holds it.
     *
     * substitute("${toString}", {});  // "${toString}"
     */
    it("should never read inherited object properties as variables", () => {
        expect(substitute("${toString}", {})).toBe("${toString}");
    });

    /** An empty value is still a value. */
    it("should substitute an empty value", () => {
        expect(substitute("a${empty}b", { empty: "" })).toBe("ab");
    });
});

describe("references() and unresolved()", () => {
    /** Every referenced name, each once. */
    it("should return every referenced variable name, without repeats", () => {
        expect(references("${a}/x/${b}")).toEqual(["a", "b"]);
        expect(references("${a}/${a}")).toEqual(["a"]);
        expect(references("/plain/path")).toEqual([]);
    });

    /** Only the names the scope does not hold. */
    it("should list the names a scope does not resolve", () => {
        expect(unresolved("${a}/${b}", { a: "1" })).toEqual(["b"]);
        expect(unresolved("${a}")).toEqual(["a"]);
    });
});

describe("substituteStrict()", () => {
    /** Behaves like substitute() when every reference resolves. */
    it("should substitute normally when all references resolve", () => {
        expect(substituteStrict("${root}/out.md", { root: "/proj" }, "somewhere")).toBe("/proj/out.md");
    });

    /** Throws a ConfigError naming the variable and where it was used. */
    it("should throw naming the variable and the context", () => {
        const where = "compilation.targets[0].entryPoint";
        const text = shown(() => substituteStrict("${typo}/x", { other: "y" }, where));

        expect(text).toMatch(/\$\{typo\}/);
        expect(text).toMatch(/compilation\.targets\[0\]\.entryPoint/);

        try {
            substituteStrict("${typo}", {}, where);
        } catch (error) {
            expect(isSousErrorOfKind(error, "config")).toBe(true);
        }
    });

    /** Shows the raw value and what is in scope, so the mistake is plain. */
    it("should include the raw value and the in-scope variable names", () => {
        const text = shown(() => substituteStrict("${typo}/x", { real: "v" }, "here"));

        expect(text).toContain("raw value: ${typo}/x");
        expect(text).toContain("real");
    });

    /** Points at `.sous/.env.local` as a place the value can come from. */
    it("should point at .sous/.env.local as a source for the value", () => {
        expect(shown(() => substituteStrict("${missing}", {}, "here"))).toMatch(/\.sous\/\.env\.local/);
    });

    /** Names every unresolved variable. */
    it("should name all unresolved variables", () => {
        const text = shown(() => substituteStrict("${a}/${b}", {}, "here"));

        expect(text).toContain("${a}");
        expect(text).toContain("${b}");
    });
});

describe("substituteValue()", () => {
    /**
     * Substitutes every string in a JSON value, keys left alone.
     *
     * substituteValue({ "${k}": ["${a}"] }, { a: "1" }, "x");  // { "${k}": ["1"] }
     */
    it("should substitute every string inside objects and arrays", () => {
        const value = { dir: "${root}/out", list: ["${a}", 3, true, null], "${key}": { deep: "${a}" } };

        expect(substituteValue(value, { root: "/p", a: "1" }, "x")).toEqual({
            dir: "/p/out",
            list: ["1", 3, true, null],
            "${key}": { deep: "1" },
        });
    });

    /** Names the exact path of a string that does not resolve. */
    it("should name the path of a string that does not resolve", () => {
        expect(shown(() => substituteValue({ outputs: [{ dir: "${nope}" }] }, {}, "target"))).toContain(
            "target.outputs[0].dir",
        );
    });
});

describe("normalizePath()", () => {
    /** Collapses `..` in an absolute path, so prune's prefix checks match. */
    it("should collapse . and .. in an absolute path", () => {
        expect(normalizePath("/repo/.sous/../.claude/./skills", undefined)).toBe("/repo/.claude/skills");
    });

    /** Leaves a relative path alone. */
    it("should leave a relative path alone", () => {
        expect(normalizePath("docs/../x", undefined)).toBe("docs/../x");
    });

    /** Expands a leading `~`. */
    it("should expand a leading ~ to the home directory", () => {
        expect(normalizePath("~/notes/../x", "/home/me")).toBe("/home/me/x");
        expect(normalizePath("~", "/home/me")).toBe("/home/me");
        expect(normalizePath("~other/x", "/home/me")).toBe("~other/x");
        expect(normalizePath("~/x", undefined)).toBe("~/x");
    });
});
