import { describe, it, expect } from "vitest";
import {
  candidateToRef,
  describeCandidate,
  describeSearch,
  searchBareName,
  type RefCandidate,
} from "./ref-search.js";
import type { IndexFile } from "./formats/index-file.js";

/**
 * Unit tests for one-word ref resolution. The search decides what
 * `sous subscribe task-files` means, so both meanings of a word, the case where
 * it is both at once, and the documented candidate order are covered here.
 */

/** Builds an index holding the given `namespace/recipe` keys. */
function indexOf(name: string, keys: string[], namespaces?: string[]): IndexFile {
  const recipes: Record<string, unknown> = {};
  const declared: Record<string, unknown> = {};

  for (const key of keys) {
    const namespace = key.slice(0, key.indexOf("/"));
    declared[namespace] = {};
    recipes[key] = {
      path: `recipes/${key}`,
      description: `The ${key} recipe`,
      versions: {
        "1.0.0": { hash: "sha256:0", tag: `${key}@1.0.0`, prerelease: false },
      },
    };
  }
  for (const namespace of namespaces ?? []) declared[namespace] = {};

  return {
    formatVersion: 1,
    name,
    generatedAt: "2026-01-01T00:00:00.000Z",
    generator: "1.0.0",
    namespaces: declared,
    recipes,
  } as unknown as IndexFile;
}

describe("searchBareName()", () => {
  /** A word that names a namespace resolves to the whole namespace. */
  it("should find an exact namespace match", () => {
    const candidates = searchBareName({
      name: "workflow",
      repoOrder: ["fixtures"],
      indexes: new Map([["fixtures", indexOf("fixtures", ["workflow/task-files"])]]),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.ref).toBe("fixtures:workflow");
    expect(candidates[0]!.kind).toBe("namespace");
    expect(candidates[0]!.recipe).toBeUndefined();
  });

  /** A word that names no namespace is looked for among the recipe names. */
  it("should find a recipe by name across every namespace and repository", () => {
    const candidates = searchBareName({
      name: "task-files",
      repoOrder: ["fixtures", "extras"],
      indexes: new Map([
        ["fixtures", indexOf("fixtures", ["workflow/task-files", "workflow/other"])],
        ["extras", indexOf("extras", ["tooling/formatter"])],
      ]),
    });

    expect(candidates.map((candidate) => candidate.ref)).toEqual([
      "fixtures:workflow/task-files",
    ]);
    expect(candidates[0]!.kind).toBe("recipe");
    expect(candidates[0]!.description).toBe("The workflow/task-files recipe");
  });

  /**
   * A word can be both a namespace in one repository and a recipe name in
   * another. Both meanings are candidates, and the namespace one is listed
   * first, because the namespace search runs first.
   */
  it("should return both meanings when a word is a namespace and a recipe name", () => {
    const candidates = searchBareName({
      name: "task-files",
      repoOrder: ["fixtures", "extras"],
      indexes: new Map([
        ["fixtures", indexOf("fixtures", ["task-files/daily"])],
        ["extras", indexOf("extras", ["workflow/task-files"])],
      ]),
    });

    expect(candidates.map((candidate) => candidate.ref)).toEqual([
      "fixtures:task-files",
      "extras:workflow/task-files",
    ]);
    expect(candidates.map((candidate) => candidate.kind)).toEqual(["namespace", "recipe"]);
  });

  /**
   * The order is the contract, because it is the order candidates are listed in
   * and the one '--accept-first' picks from: repository order first, then
   * namespace, then recipe name.
   */
  it("should order candidates by repository, then namespace, then recipe name", () => {
    const candidates = searchBareName({
      name: "shared",
      repoOrder: ["sous-recipes", "beta", "alpha"],
      indexes: new Map([
        ["alpha", indexOf("alpha", ["zeta/shared", "alpha-ns/shared"])],
        ["beta", indexOf("beta", ["mid/shared"])],
        ["sous-recipes", indexOf("sous-recipes", ["core/shared"], ["shared"])],
      ]),
    });

    expect(candidates.map((candidate) => candidate.ref)).toEqual([
      "sous-recipes:shared",
      "sous-recipes:core/shared",
      "beta:mid/shared",
      "alpha:alpha-ns/shared",
      "alpha:zeta/shared",
    ]);
  });

  /** A name nothing publishes finds nothing at all. */
  it("should find nothing when no namespace and no recipe carries the name", () => {
    expect(
      searchBareName({
        name: "nothing-like-this",
        repoOrder: ["fixtures"],
        indexes: new Map([["fixtures", indexOf("fixtures", ["workflow/task-files"])]]),
      })
    ).toEqual([]);
  });
});

describe("describeCandidate()", () => {
  /** A namespace candidate spells out that it means the whole namespace. */
  it("should spell out what a namespace candidate means", () => {
    const candidate: RefCandidate = {
      repo: "fixtures",
      namespace: "workflow",
      ref: "fixtures:workflow",
      kind: "namespace",
    };
    expect(describeCandidate(candidate)).toContain("the whole namespace 'workflow'");
    expect(describeCandidate(candidate)).toContain("repository 'fixtures'");
  });

  /** A recipe candidate names its namespace and repository too. */
  it("should describe a recipe candidate with its namespace and repository", () => {
    const described = describeCandidate({
      repo: "extras",
      namespace: "tooling",
      recipe: "formatter",
      ref: "extras:tooling/formatter",
      kind: "recipe",
      description: "A formatter recipe",
    });
    expect(described).toContain("extras:tooling/formatter");
    expect(described).toContain("A formatter recipe");
  });
});

describe("candidateToRef()", () => {
  /** The chosen candidate keeps its repository qualifier and the asked range. */
  it("should keep the repository qualifier and carry the range over", () => {
    expect(
      candidateToRef(
        {
          repo: "fixtures",
          namespace: "workflow",
          recipe: "task-files",
          ref: "fixtures:workflow/task-files",
          kind: "recipe",
        },
        { namespace: "task-files", range: "^1.0.0" }
      )
    ).toEqual({
      repo: "fixtures",
      namespace: "workflow",
      recipe: "task-files",
      range: "^1.0.0",
    });
  });
});

describe("describeSearch()", () => {
  /** What was searched, and what could not be. */
  it("should name the repositories searched and the ones with no readable index", () => {
    const lines = describeSearch({
      name: "missing",
      repoOrder: ["fixtures", "offline"],
      indexes: new Map([["fixtures", indexOf("fixtures", ["workflow/task-files"])]]),
    });

    expect(lines.join("\n")).toContain("fixtures");
    expect(lines.join("\n")).toContain("offline");
  });
});
