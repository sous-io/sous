import { describe, expect, it } from "vitest";
import { stateOf } from "../../../test/utils/ref-fixtures.js";
import { RepoQualifierSplitter } from "./repo-qualifier-splitter.js";

describe("RepoQualifierSplitter", () => {
  const splitter = new RepoQualifierSplitter();

  /**
   * The splitter should take `name:` off the front and record the repository.
   *
   * split("sous-recipes:workflow/alpha")
   * // -> [{ rest: "workflow/alpha", repo: { kind: "repo", name: "sous-recipes" } }]
   */
  it("should read a repo qualifier", () => {
    const [out] = splitter.split(stateOf("sous-recipes:workflow/alpha"));
    expect(out).toMatchObject({
      rest: "workflow/alpha",
      repo: { kind: "repo", name: "sous-recipes" },
    });
  });

  /**
   * A qualifier may be a glob.
   *
   * split("sous-*:workflow") // -> repo name "sous-*"
   */
  it("should accept a glob as the qualifier", () => {
    const [out] = splitter.split(stateOf("sous-*:workflow"));
    expect(out?.repo?.name).toBe("sous-*");
  });

  /**
   * An empty qualifier, a second qualifier and a qualifier that is not
   * kebab-case are turned down with a reason.
   *
   * split(":workflow") // -> [] and "qualifier before ':' is empty"
   */
  it("should turn down a malformed qualifier", () => {
    const empty = stateOf(":workflow");
    expect(splitter.split(empty)).toEqual([]);
    expect(empty.problems[0]).toContain("qualifier before ':' is empty");
    const twice = stateOf("a:b:c");
    expect(splitter.split(twice)).toEqual([]);
    expect(twice.problems[0]).toContain("at most one 'repo:'");
    const bad = stateOf("re_po:workflow");
    expect(splitter.split(bad)).toEqual([]);
    expect(bad.problems[0]).toContain("must be kebab-case");
  });

  /**
   * A URL, an SSH remote, a colon after a slash and a state that already has
   * a repository pass through unchanged.
   *
   * split("git@github.com:o/r") // -> the same state
   */
  it("should leave locations and qualified readings alone", () => {
    for (const text of ["https://github.com/o/r", "git@github.com:o/r", "a/b:c", "workflow"]) {
      const state = stateOf(text);
      expect(splitter.split(state)).toEqual([state]);
    }
    const qualified = stateOf("x:y", { repo: { kind: "repo", name: "z" } });
    expect(splitter.split(qualified)).toEqual([qualified]);
  });
});
