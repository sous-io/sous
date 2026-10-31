import { ConfigError, definePlugin } from "@sous-io/plugin-api";
import { beforeAll, describe, expect, it } from "vitest";
import { buildRefs, printed, type Refs } from "../../test/fixtures.js";
import { finishRef, splitter } from "./partial-ref.js";
import { parseError } from "./parser.js";

let refs: Refs;

beforeAll(async () => {
    refs = await buildRefs();
});

/** The readings of a ref, printed with their kinds. */
const readings = (input: string): string[] => printed(refs.format, refs.parser.parse(input).readings);

/** The message of the error a ref that reads no way raises. */
const problem = (input: unknown): string => {
    const result = refs.parser.parse(input as string);

    expect(result.readings).toEqual([]);

    return parseError(result).message;
};

describe("refs.parser", () => {
    /**
     * A bare word reads every way it can.
     *
     * parse("workflow") // -> repo, namespace, recipe, variable and envVar readings
     */
    it("should return every reading of a bare word", () => {
        expect(readings("workflow")).toEqual(["repo:workflow", "namespace:workflow", "recipe:workflow", "variable:workflow", "envVar:workflow"]);
    });

    /**
     * The splitters run by their order and combine a query, a range, a qualifier and names.
     *
     * parse("sous-recipes:workflow/alpha@^1.2?x=a%20b") // -> a recipe in sous-recipes, range ^1.2, vars { x: "a b" }
     */
    it("should combine the splitters in their order", () => {
        expect(refs.parser.parse("sous-recipes:workflow/alpha@^1.2?x=a%20b").readings[0]).toEqual({
            kind: "recipe",
            name: "alpha",
            namespace: { kind: "namespace", name: "workflow", repo: { kind: "repo", name: "sous-recipes" } },
            range: "^1.2",
            vars: { x: "a b" },
        });
    });

    /**
     * Text that could be a glob path holding `?` and `=` keeps both readings.
     *
     * parse("w/a/f.md?x=1") // -> a recipe file with vars, and one with a glob path
     */
    it("should keep the glob reading of a path that looks like it has a query", () => {
        const parsed = refs.parser.parse("w/a/f.md?x=1").readings;

        expect(parsed.map((ref) => ref.kind)).toEqual(["recipeFile", "recipeFile"]);
        expect(parsed[0]).toMatchObject({ path: "f.md", vars: { x: "1" } });
        expect(parsed[1]).toMatchObject({ path: "f.md?x=1", glob: true });
    });

    /**
     * A URL keeps its own query.
     *
     * parse("https://github.com/o/r/w") // -> no vars
     */
    it("should leave a URL's query to the URL", () => {
        expect(refs.parser.parse("https://github.com/o/r/w").readings.every((ref) => ref.vars === undefined)).toBe(true);
    });

    /**
     * A plugin's `ref-splitter` entity runs among the built-ins by its order.
     *
     * parse("plugin") with a splitter reading "plugin" // -> its ref first
     */
    it("should run a splitter a plugin adds", async () => {
        const pluginSplitter = splitter("from-plugin", 45, (state) =>
            state.rest === "plugin" ? [finishRef(state, { kind: "envVar", name: "FROM_PLUGIN" })] : [state],
        );
        const withPlugin = await buildRefs({
            plugins: [definePlugin({ name: "test-splitter", version: "1.0.0", register: (sous) => sous.entities.add("ref-splitter", pluginSplitter) })],
        });

        expect(withPlugin.parser.parse("plugin").readings[0]).toEqual({ kind: "envVar", name: "FROM_PLUGIN" });
    });

    /**
     * Text that fits no form has no readings, and its error quotes the input and every reason.
     *
     * parseError(parse("")) // -> "Invalid ref '': a ref must not be empty."
     */
    it("should give no readings, and an error that quotes the input and says why", () => {
        expect(problem("")).toMatch(/must not be empty/);
        expect(problem("   ")).toMatch(/must not be empty/);
        expect(problem("@workflow")).toMatch(/no '@' prefix/);
        expect(problem("~workflow")).toMatch(/no '~' prefix/);
        expect(problem(42)).toMatch(/must be a string/);
        expect(problem("a:b:c")).toMatch(/Invalid ref 'a:b:c': a ref may carry at most one/);
        expect(problem("a/b/c d")).toMatch(/holds a space/);
        expect(problem("work-flow$")).toMatch(/Invalid ref 'work-flow\$'/);
    });

    /**
     * The error is a ConfigError with the forms a ref may take under it.
     *
     * parseError(...).details // -> ["A ref is written as 'namespace', ..."]
     */
    it("should list the forms of a ref under the error", () => {
        const error = parseError(refs.parser.parse("a:b:c"));

        expect(error).toBeInstanceOf(ConfigError);
        expect(error.details[0]).toMatch(/^A ref is written as 'namespace'/);
        expect(parseError({ input: "x", readings: [], problems: ["one.", "two."] }).message).toBe("Invalid ref 'x': it fits no form of a ref:\n    one.\n    two.");
        expect(parseError({ input: "x", readings: [], problems: [] }).message).toBe("Invalid ref 'x': it does not fit any form of a ref.");
    });
});
