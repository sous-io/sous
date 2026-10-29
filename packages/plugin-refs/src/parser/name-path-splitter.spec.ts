import { beforeAll, describe, expect, it } from "vitest";
import { buildRefs, stateOf, type Refs } from "../../test/fixtures.js";
import type { PartialRef, RepoRef, SousRef } from "../types.js";
import { namePathSplitter } from "./name-path-splitter.js";

let ctx: Refs["ctx"];

beforeAll(async () => {
    ctx = (await buildRefs()).ctx;
});

/** The finished refs a split made. */
function refsOf(rest: string, extra: Partial<PartialRef> = {}): SousRef[] {
    return namePathSplitter
        .split(stateOf(rest, extra), ctx)
        .map((state) => state.ref)
        .filter((ref): ref is SousRef => ref !== undefined);
}

describe("the name/path splitter", () => {
    /**
     * One word reads as a namespace, a repository, a recipe and a variable, and stays unread too.
     *
     * refsOf("workflow") // -> namespace, repo, recipe, variable
     */
    it("should read one word every way it can be read", () => {
        expect(namePathSplitter.split(stateOf("workflow"), ctx)[0]?.ref).toBeUndefined();
        expect(refsOf("workflow").map((ref) => ref.kind)).toEqual(["namespace", "repo", "recipe", "variable"]);
    });

    /**
     * `namespace/recipe` is a recipe.
     *
     * refsOf("workflow/alpha") // -> the recipe alpha in workflow
     */
    it("should read namespace/recipe as a recipe", () => {
        expect(refsOf("workflow/alpha")).toEqual([{ kind: "recipe", name: "alpha", namespace: { kind: "namespace", name: "workflow" } }]);
    });

    /**
     * `namespace/*` spells a namespace out, and is a recipe glob as well.
     *
     * refsOf("workflow/*") // -> the namespace (wildcard), and the recipe "*"
     */
    it("should read namespace/* as a spelled-out namespace and a recipe glob", () => {
        const refs = refsOf("workflow/*");

        expect(refs[0]).toEqual({ kind: "namespace", name: "workflow", wildcard: true });
        expect(refs[1]).toMatchObject({ kind: "recipe", name: "*", glob: true });
    });

    /**
     * A name after a `.` is a variable of the recipe before it.
     *
     * refsOf("workflow/task-files.apiUrl") // -> the variable apiUrl of workflow/task-files
     */
    it("should read a variable after a dot", () => {
        expect(refsOf("workflow/task-files.apiUrl")).toContainEqual({
            kind: "variable",
            name: "apiUrl",
            recipe: { kind: "recipe", name: "task-files", namespace: { kind: "namespace", name: "workflow" } },
        });
        expect(refsOf("task-files.apiUrl")).toContainEqual({ kind: "variable", name: "apiUrl", recipe: { kind: "recipe", name: "task-files" } });
    });

    /**
     * A third segment and beyond is a path inside a recipe, which may be a glob; braces stay whole.
     *
     * refsOf("workflow/alpha/_partials/*.md") // -> a recipe file with a glob path
     */
    it("should read a file inside a recipe, keeping a brace group whole", () => {
        expect(refsOf("workflow/alpha/_partials/*.md")).toEqual([
            {
                kind: "recipeFile",
                path: "_partials/*.md",
                glob: true,
                recipe: { kind: "recipe", name: "alpha", namespace: { kind: "namespace", name: "workflow" } },
            },
        ]);
        expect(refsOf("workflow/alpha/{a/b,c}.md")[0]).toMatchObject({ path: "{a/b,c}.md" });
    });

    /**
     * The repository qualifier goes on the nearest parent; after a location only a namespace reads.
     *
     * refsOf("w/a", { repo }) // -> the recipe, with the qualifier on its namespace
     */
    it("should place the repository qualifier on the nearest parent", () => {
        const repo: RepoRef = { kind: "repo", name: "r" };
        const located: RepoRef = {
            kind: "repo",
            location: { provider: "github", host: "github.com", repoPath: "o/r", identity: "github.com/o/r", url: "https://github.com/o/r" },
        };

        expect(refsOf("w/a", { repo })[0]).toMatchObject({ namespace: { repo } });
        expect(refsOf("a", { repo }).map((ref) => ref.kind)).toEqual(["namespace", "recipe", "variable"]);
        expect(refsOf("a", { repo: located }).map((ref) => ref.kind)).toEqual(["namespace"]);
    });

    /**
     * A ranged word is only a recipe; a namespace is not versioned.
     *
     * refsOf("workflow", { range: "^1" }) // -> the recipe workflow@^1
     */
    it("should not read a ranged name as a namespace", () => {
        const state = stateOf("workflow", { range: "^1" });
        const refs = namePathSplitter.split(state, ctx).flatMap((out) => (out.ref === undefined ? [] : [out.ref]));

        expect(refs.map((ref) => ref.kind)).toEqual(["recipe"]);
        expect(refs[0]).toMatchObject({ range: "^1" });
        expect(state.problems[0]).toContain("namespaces are not versioned");
    });

    /**
     * Query values ride on every reading.
     *
     * refsOf("workflow", { vars: { a: "1" } }) // -> each with vars { a: "1" }
     */
    it("should carry the query values", () => {
        for (const ref of refsOf("workflow", { vars: { a: "1" } })) {
            expect(ref.vars).toEqual({ a: "1" });
        }
    });

    /**
     * A name or path that does not read leaves a reason and no reading.
     *
     * split("1a/b") // -> no ref, and "must be kebab-case"
     */
    it("should record why a name or path does not read", () => {
        const cases: Array<[string, string]> = [
            ["/alpha", "the namespace is empty"],
            ["workflow/", "recipe name after '/' is empty"],
            ["a//b", "empty segment"],
            ["1a/b", "must be kebab-case"],
            ["a/1b", "must be kebab-case"],
            ["a/b/c d", "holds a space"],
            ["a/1b/c", "must be kebab-case"],
        ];

        for (const [text, reason] of cases) {
            const state = stateOf(text);

            expect(namePathSplitter.split(state, ctx).every((entry) => entry.ref === undefined)).toBe(true);
            expect(state.problems.join(" "), text).toContain(reason);
        }
    });

    /**
     * A finished reading passes through.
     *
     * split(finished) // -> [finished]
     */
    it("should leave a finished reading alone", () => {
        const done = stateOf("", { ref: { kind: "envVar", name: "X" } });

        expect(namePathSplitter.split(done, ctx)).toEqual([done]);
    });
});
