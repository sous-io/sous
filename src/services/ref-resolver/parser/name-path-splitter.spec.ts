import { describe, expect, it } from "vitest";
import { stateOf } from "../../../test/utils/ref-fixtures.js";
import { NamePathSplitter } from "./name-path-splitter.js";
import type { SousRef } from "../types.js";

const splitter = new NamePathSplitter();

/** The finished refs a splitter made from some text. */
function refsOf(rest: string, extra = {}): SousRef[] {
  return splitter
    .split(stateOf(rest, extra))
    .map((state) => state.ref)
    .filter((ref): ref is SousRef => ref !== undefined);
}

describe("NamePathSplitter", () => {
  /**
   * One word reads as a namespace, a recipe, a repository and a variable, and
   * the text stays unread for the environment variable splitter.
   *
   * split("workflow") // -> namespace, repo, recipe (no namespace), variable
   */
  it("should read one word every way it can be read", () => {
    const out = splitter.split(stateOf("workflow"));
    expect(out[0]?.ref).toBeUndefined();
    expect(refsOf("workflow").map((ref) => ref.kind)).toEqual([
      "namespace",
      "repo",
      "recipe",
      "variable",
    ]);
  });

  /**
   * Two segments read as a recipe in a namespace.
   *
   * split("workflow/alpha")
   * // -> { kind: "recipe", name: "alpha", namespace: { name: "workflow" } }
   */
  it("should read namespace/recipe as a recipe", () => {
    expect(refsOf("workflow/alpha")).toEqual([
      {
        kind: "recipe",
        name: "alpha",
        namespace: { kind: "namespace", name: "workflow" },
      },
    ]);
  });

  /**
   * `namespace/*` is a namespace spelled out, and also every recipe in it.
   *
   * split("workflow/*") // -> namespace (wildcard) and a recipe glob
   */
  it("should read namespace/* as a spelled-out namespace and a recipe glob", () => {
    const refs = refsOf("workflow/*");
    expect(refs[0]).toEqual({ kind: "namespace", name: "workflow", wildcard: true });
    expect(refs[1]).toMatchObject({ kind: "recipe", name: "*", glob: true });
  });

  /**
   * A `.` splits a variable's name from its recipe, with or without a namespace.
   *
   * split("workflow/task-files.apiUrl") // -> variable apiUrl of workflow/task-files
   */
  it("should read a variable after a dot", () => {
    const refs = refsOf("workflow/task-files.apiUrl");
    expect(refs).toContainEqual({
      kind: "variable",
      name: "apiUrl",
      recipe: {
        kind: "recipe",
        name: "task-files",
        namespace: { kind: "namespace", name: "workflow" },
      },
    });
    expect(refsOf("task-files.apiUrl")).toContainEqual({
      kind: "variable",
      name: "apiUrl",
      recipe: { kind: "recipe", name: "task-files" },
    });
  });

  /**
   * Three or more segments name a file inside a recipe, and the path may be a
   * glob.
   *
   * split("workflow/alpha/_partials/*.md") // -> recipeFile, glob
   */
  it("should read a file inside a recipe", () => {
    expect(refsOf("workflow/alpha/_partials/*.md")).toEqual([
      {
        kind: "recipeFile",
        path: "_partials/*.md",
        glob: true,
        recipe: {
          kind: "recipe",
          name: "alpha",
          namespace: { kind: "namespace", name: "workflow" },
        },
      },
    ]);
  });

  /**
   * A glob in braces keeps its slashes.
   *
   * split("workflow/alpha/{a/b,c}.md") // -> path "{a/b,c}.md"
   */
  it("should keep a brace group whole", () => {
    expect(refsOf("workflow/alpha/{a/b,c}.md")[0]).toMatchObject({ path: "{a/b,c}.md" });
  });

  /**
   * The repository qualifier lands on the namespace when there is one, and
   * on the recipe when there is none; a located repository takes only a
   * namespace.
   *
   * split("w/a" qualified by repo r) // -> namespace.repo is r
   */
  it("should place the repository qualifier on the nearest parent", () => {
    const repo = { kind: "repo" as const, name: "r" };
    expect(refsOf("w/a", { repo })[0]).toMatchObject({ namespace: { repo } });
    expect(refsOf("a", { repo }).map((ref) => ref.kind)).toEqual(["namespace", "recipe", "variable"]);
    const located = { kind: "repo" as const, location: { provider: "github" as const, host: "github.com", repoPath: "o/r", identity: "github.com/o/r", url: "https://github.com/o/r" } };
    expect(refsOf("a", { repo: located }).map((ref) => ref.kind)).toEqual(["namespace"]);
  });

  /**
   * A range makes a bare word a recipe only, because namespaces are not
   * versioned.
   *
   * split("workflow" with range "^1") // -> only a recipe, and a problem
   */
  it("should not read a ranged name as a namespace", () => {
    const state = stateOf("workflow", { range: "^1" });
    const refs = splitter.split(state).flatMap((out) => (out.ref === undefined ? [] : [out.ref]));
    expect(refs.map((ref) => ref.kind)).toEqual(["recipe"]);
    expect(refs[0]).toMatchObject({ range: "^1" });
    expect(state.problems[0]).toContain("namespaces are not versioned");
  });

  /**
   * Query values ride along on every finished ref.
   *
   * split("workflow" with vars) // -> every ref carries them
   */
  it("should carry the query values", () => {
    for (const ref of refsOf("workflow", { vars: { a: "1" } })) {
      expect(ref.vars).toEqual({ a: "1" });
    }
  });

  /**
   * Empty segments and names that are not names are turned down with the
   * reason, and leave only the unread state.
   *
   * split("/alpha") // -> no refs, and "the namespace is empty"
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
      const out = splitter.split(state);
      expect(out.every((entry) => entry.ref === undefined)).toBe(true);
      expect(state.problems.join(" "), text).toContain(reason);
    }
  });

  /**
   * A finished reading is never read again.
   *
   * split(finished) // -> the same state
   */
  it("should leave a finished reading alone", () => {
    const done = stateOf("", { ref: { kind: "envVar", name: "X" } });
    expect(splitter.split(done)).toEqual([done]);
  });
});
