import { beforeAll, describe, expect, it } from "vitest";
import { buildRefs, stateOf, type Refs } from "../../test/fixtures.js";
import { decodeQuery, envVarSplitter, querySplitter, rangeSplitter, repoQualifierSplitter } from "./splitters.js";

let ctx: Refs["ctx"];

beforeAll(async () => {
    ctx = (await buildRefs()).ctx;
});

describe("decodeQuery()", () => {
    /**
     * decodeQuery decodes every pair of a percent-encoded query.
     *
     * decodeQuery("a=1&b=two%20words&c="); // -> { a: "1", b: "two words", c: "" }
     */
    it("should decode every pair", () => {
        expect(decodeQuery("a=1&b=two%20words&c=")).toEqual({ a: "1", b: "two words", c: "" });
    });

    /**
     * Anything that is not a valid query gives undefined.
     *
     * decodeQuery("a=%zz"); // -> undefined
     */
    it("should return undefined for anything that is not a valid query", () => {
        expect(decodeQuery("a=%zz")).toBeUndefined();
        expect(decodeQuery("")).toBeUndefined();
        expect(decodeQuery("novalue")).toBeUndefined();
        expect(decodeQuery("a=b c")).toBeUndefined();
        expect(decodeQuery("a={x}")).toBeUndefined();
    });
});

describe("the query splitter", () => {
    /**
     * A query is read off, and the unsplit reading is kept too (it may be a glob path).
     *
     * split("workflow/alpha?x=1&y=a%20b") // -> rest "workflow/alpha" with vars, and the text as it was
     */
    it("should read a query and keep the unsplit reading too", () => {
        const out = querySplitter.split(stateOf("workflow/alpha?x=1&y=a%20b"), ctx);

        expect(out.map((state) => state.rest)).toEqual(["workflow/alpha", "workflow/alpha?x=1&y=a%20b"]);
        expect(out[0]!.vars).toEqual({ x: "1", y: "a b" });
        expect(out[1]!.vars).toBeUndefined();
    });

    /**
     * A URL keeps its own query; a malformed query, no query, a leading `?` and a finished
     * reading pass through unchanged.
     *
     * split("https://github.com/o/r?x=1") // -> the same state
     */
    it("should pass a URL, a malformed query, plain text and a finished reading through", () => {
        for (const state of [stateOf("https://github.com/o/r?x=1"), stateOf("a/b?x=%zz"), stateOf("workflow"), stateOf("?x=1")]) {
            expect(querySplitter.split(state, ctx)).toEqual([state]);
        }

        const done = stateOf("", { ref: { kind: "envVar", name: "X" } });

        expect(querySplitter.split(done, ctx)).toEqual([done]);
    });
});

describe("the range splitter", () => {
    /**
     * A version range is read off the end.
     *
     * split("workflow/alpha@^1.2") // -> rest "workflow/alpha", range "^1.2"
     */
    it("should read a version range", () => {
        expect(rangeSplitter.split(stateOf("workflow/alpha@^1.2"), ctx)[0]).toMatchObject({ rest: "workflow/alpha", range: "^1.2" });
    });

    /**
     * The `@` of an SSH remote is never a range.
     *
     * split("git@github.com:o/r.git@^1") // -> rest "git@github.com:o/r.git", range "^1"
     */
    it("should not mistake an SSH remote's @ for a range", () => {
        const state = stateOf("git@github.com:o/r.git");

        expect(rangeSplitter.split(state, ctx)).toEqual([state]);
        expect(rangeSplitter.split(stateOf("git@github.com:o/r.git@^1"), ctx)[0]).toMatchObject({ rest: "git@github.com:o/r.git", range: "^1" });
    });

    /**
     * An empty range and a second `@` are turned down with a reason.
     *
     * split("a@") // -> [] and "not followed by a version range"
     */
    it("should turn down an empty range and a second @", () => {
        const empty = stateOf("a@");

        expect(rangeSplitter.split(empty, ctx)).toEqual([]);
        expect(empty.problems[0]).toContain("not followed by a version range");

        const twice = stateOf("a@1@2");

        expect(rangeSplitter.split(twice, ctx)).toEqual([]);
        expect(twice.problems[0]).toContain("at most one '@'");
    });

    /**
     * Text after `@` that is not a range stays in the text, with a reason kept in case nothing reads.
     *
     * split("a/b@nope") // -> the same state, and "is not a version range"
     */
    it("should leave a range that is not one in the text", () => {
        const state = stateOf("a/b@nope");

        expect(rangeSplitter.split(state, ctx)).toEqual([state]);
        expect(state.problems[0]).toContain("is not a version range");
    });

    /**
     * Text with no range, or with an `@` before the last `/`, passes through.
     *
     * split("a@b/c") // -> the same state
     */
    it("should pass text with no range through unchanged", () => {
        for (const state of [stateOf("workflow"), stateOf("a@b/c")]) {
            expect(rangeSplitter.split(state, ctx)).toEqual([state]);
        }
    });
});

describe("the env var splitter", () => {
    /**
     * A legal environment variable name is read whole, and the text is kept unread for the others.
     *
     * split("SOUS_VAR_API_URL") // -> [the state, a finished envVar]
     */
    it("should add an envVar reading and keep the text unread", () => {
        const state = stateOf("SOUS_VAR_API_URL");
        const out = envVarSplitter.split(state, ctx);

        expect(out[0]).toBe(state);
        expect(out[1]?.ref).toEqual({ kind: "envVar", name: "SOUS_VAR_API_URL" });
        expect(out[1]?.rest).toBe("");
    });

    /**
     * Anything else, a ranged or qualified reading included, passes through.
     *
     * split("1abc") // -> the same state
     */
    it("should pass anything else through unchanged", () => {
        for (const state of [
            stateOf("workflow/alpha"),
            stateOf("1abc"),
            stateOf("NAME", { range: "^1" }),
            stateOf("NAME", { repo: { kind: "repo", name: "r" } }),
        ]) {
            expect(envVarSplitter.split(state, ctx)).toEqual([state]);
        }
    });

    /**
     * The query values read so far ride on the finished ref.
     *
     * split("NAME" with vars { a: "1" }) // -> { kind: "envVar", name: "NAME", vars: { a: "1" } }
     */
    it("should carry the query values", () => {
        expect(envVarSplitter.split(stateOf("NAME", { vars: { a: "1" } }), ctx)[1]?.ref).toEqual({ kind: "envVar", name: "NAME", vars: { a: "1" } });
    });
});

describe("the repo qualifier splitter", () => {
    /**
     * `name:` is read off the front, and may be a glob.
     *
     * split("sous-recipes:workflow/alpha") // -> rest "workflow/alpha", repo "sous-recipes"
     */
    it("should read a repo qualifier, a glob included", () => {
        expect(repoQualifierSplitter.split(stateOf("sous-recipes:workflow/alpha"), ctx)[0]).toMatchObject({
            rest: "workflow/alpha",
            repo: { kind: "repo", name: "sous-recipes" },
        });
        expect(repoQualifierSplitter.split(stateOf("sous-*:workflow"), ctx)[0]?.repo?.name).toBe("sous-*");
    });

    /**
     * An empty qualifier, two of them and one that is not kebab case are turned down.
     *
     * split("a:b:c") // -> [] and "at most one 'repo:'"
     */
    it("should turn down a malformed qualifier", () => {
        const cases: Array<[string, string]> = [
            [":workflow", "qualifier before ':' is empty"],
            ["a:b:c", "at most one 'repo:'"],
            ["re_po:workflow", "must be kebab-case"],
        ];

        for (const [text, problem] of cases) {
            const state = stateOf(text);

            expect(repoQualifierSplitter.split(state, ctx)).toEqual([]);
            expect(state.problems[0]).toContain(problem);
        }
    });

    /**
     * Locations, a `:` after a `/`, a plain word and a qualified reading pass through.
     *
     * split("https://github.com/o/r") // -> the same state
     */
    it("should leave locations and qualified readings alone", () => {
        for (const text of ["https://github.com/o/r", "git@github.com:o/r", "a/b:c", "workflow"]) {
            const state = stateOf(text);

            expect(repoQualifierSplitter.split(state, ctx)).toEqual([state]);
        }

        const qualified = stateOf("x:y", { repo: { kind: "repo", name: "z" } });

        expect(repoQualifierSplitter.split(qualified, ctx)).toEqual([qualified]);
    });
});
