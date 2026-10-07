import { describe, expect, it } from "vitest";
import { candidates, recipeRef, nsRef, variableOf } from "../../test/utils/ref-fixtures.js";
import {
  describeRef,
  formatRef,
  refIdentity,
  refKey,
  refKindLabel,
  refSpelling,
} from "./format.js";
import { variableRefOf } from "./lookups/variable-lookup.js";
import { locationOf, namesOf, namespaceOf, rangeOf, recipeOf, repoOf } from "./parts.js";
import type { SousRef } from "./types.js";

/** The first reading of a written ref with the given kind. */
function reading(text: string, kind: SousRef["kind"]): SousRef {
  return candidates(text).find((ref) => ref.kind === kind)!;
}

describe("refKey()", () => {
  /**
   * The key of each kind is its canonical path, with the repository
   * qualifier in front and the range and query values left off.
   *
   * refKey(recipe "workflow/alpha" in repo r, range ^1) // -> "r:workflow/alpha"
   */
  it("should key each kind canonically", () => {
    expect(refKey(reading("workflow", "namespace"))).toBe("workflow");
    expect(refKey(reading("r:workflow/alpha@^1?x=1", "recipe"))).toBe("r:workflow/alpha");
    expect(refKey(reading("workflow/alpha/_p/x.md", "recipeFile"))).toBe("workflow/alpha/_p/x.md");
    expect(refKey(reading("workflow/alpha.apiUrl", "variable"))).toBe("workflow/alpha.apiUrl");
    expect(refKey(reading("SOUS_X", "envVar"))).toBe("SOUS_X");
    expect(refKey(reading("fixtures", "repo"))).toBe("fixtures");
    expect(refKey(reading("https://github.com/o/r", "repo") ?? {})).toBeDefined();
  });

  /**
   * A repository named only by location keys on its identity, and a browsed
   * path is part of the key.
   *
   * refKey(github://o/r/workflow) // -> "github.com/o/r:workflow"
   */
  it("should key a located repository by identity", () => {
    expect(refKey(reading("github://o/r/workflow", "namespace"))).toBe("github.com/o/r:workflow");
    expect(refKey(reading("https://github.com/o/r/tree/main/x", "repo"))).toBe(
      "github.com/o/r:tree/main/x"
    );
    expect(refKey(reading("git@github.com:o/r.git", "repo"))).toBe("github.com/o/r");
  });

  /**
   * refIdentity should tell a namespace from a repository of the same name.
   *
   * refIdentity(namespace workflow) // -> "namespace workflow"
   */
  it("should prefix the kind in the identity", () => {
    expect(refIdentity(nsRef("workflow"))).toBe("namespace workflow");
    expect(refKindLabel(nsRef("workflow"))).toBe("namespace");
  });
});

describe("formatRef()", () => {
  /**
   * The canonical form puts the qualifier first, the range after, and the
   * query values last, percent-encoded.
   *
   * formatRef(r:workflow/alpha@^1?x=a b) // -> "r:workflow/alpha@^1?x=a%20b"
   */
  it("should print the qualifier, range and query", () => {
    expect(formatRef(reading("r:workflow/alpha@^1?x=a%20b", "recipe"))).toBe(
      "r:workflow/alpha@^1?x=a%20b"
    );
    expect(formatRef(reading("workflow/alpha.apiUrl", "variable"))).toBe("workflow/alpha.apiUrl");
    expect(formatRef(reading("workflow/alpha@^1", "recipe"))).toBe("workflow/alpha@^1");
  });

  /**
   * A located repository prints as its provider's locator, a browsed path
   * with its range, and a local repository as its URL.
   *
   * formatRef(https://github.com/o/r/w/a@^1) // -> "github://o/r/w/a@^1"
   */
  it("should print a location as its provider's locator", () => {
    expect(formatRef(reading("https://github.com/o/r/w/a@^1", "recipe"))).toBe("github://o/r/w/a@^1");
    expect(formatRef(reading("https://github.com/o/r/tree/main/x@^1", "repo"))).toBe(
      "github://o/r/tree/main/x@^1"
    );
    expect(formatRef(reading("file:///x/y", "repo"))).toBe("file:///x/y");
  });
});

describe("a known repository with both a short name and a location", () => {
  /**
   * A repository this project knows by short name prints with that name,
   * whatever else it knows of it; one known only by location prints as its
   * locator, and describes itself by where it lives.
   *
   * formatRef(recipe in "mine" at github.com/o/r)  // -> "mine:w/a"
   * refSpelling(recipe at github.com/o/r)          // -> "github://o/r/w/a"
   */
  it("should print the short name first, and the locator when there is none", () => {
    const located = reading("github://o/r/w/a", "recipe");
    const known: SousRef = {
      ...recipeRef("w", "a", "mine"),
      namespace: { ...nsRef("w", "mine"), repo: { kind: "repo", name: "mine", location: locationOf(located)! } },
    };
    expect(formatRef(known)).toBe("mine:w/a");
    expect(refSpelling(known)).toBe("mine:w/a");
    expect(refSpelling(located)).toBe("github://o/r/w/a");
    expect(describeRef(located)).toBe(
      "github://o/r/w/a  (the recipe 'a' in the namespace 'w' of the repository " +
        "'https://github.com/o/r')"
    );
    expect(describeRef(reading("github://o/r/w", "namespace"))).toBe(
      "github://o/r/w  (the whole namespace 'w' in the repository 'https://github.com/o/r')"
    );
  });
});

describe("describeRef()", () => {
  /**
   * Every kind is described with its qualified name and what it is.
   *
   * describeRef(recipe) // -> "r:workflow/alpha  (the recipe 'alpha' in the namespace ...)"
   */
  it("should describe each kind", () => {
    const recipe = { ...recipeRef("workflow", "alpha", "r"), description: "Alpha" };
    expect(describeRef(recipe)).toBe(
      "r:workflow/alpha  (the recipe 'alpha' in the namespace 'workflow' of the repository 'r': Alpha)"
    );
    expect(describeRef(nsRef("workflow", "r"))).toContain("the whole namespace 'workflow'");
    expect(describeRef({ kind: "repo", name: "r" })).toBe("r  (the repository 'r')");
    expect(describeRef(reading("workflow/alpha/x.md", "recipeFile"))).toContain("the file 'x.md'");
    const variable = variableRefOf(variableOf("r", "w", "a", "apiUrl"));
    expect(describeRef(variable)).toContain("the variable 'apiUrl' of the recipe 'w/a'");
    expect(describeRef({ kind: "envVar", name: "X", variables: [variable] })).toContain(
      "answering 'apiUrl' of the recipe 'w/a'"
    );
    expect(describeRef({ kind: "envVar", name: "X" })).toBe("X  (the environment variable)");
    expect(describeRef(reading("apiUrl", "variable"))).toContain("of the recipe 'unknown'");
  });
});

describe("parts", () => {
  /**
   * The accessors find each parent wherever the kind keeps it.
   *
   * repoOf(variable of a qualified recipe) // -> the repo
   */
  it("should find parents at every depth", () => {
    const file = reading("r:w/a/x.md", "recipeFile");
    expect(repoOf(file)?.name).toBe("r");
    expect(namespaceOf(file)?.name).toBe("w");
    expect(recipeOf(file)?.name).toBe("a");
    expect(namesOf(file)).toEqual(["r", "w", "a", "x.md"]);
    expect(namesOf(reading("r:a.v", "variable"))).toEqual(["r", "a", "v"]);
    expect(repoOf(reading("r:a.v", "variable"))?.name).toBe("r");
    expect(repoOf(reading("r:apiUrl", "variable"))?.name).toBe("r");
    expect(repoOf(reading("r:a", "recipe"))?.name).toBe("r");
    expect(repoOf(reading("SOUS_X", "envVar"))).toBeUndefined();
    expect(namespaceOf(reading("SOUS_X", "envVar"))).toBeUndefined();
    expect(recipeOf(reading("w", "namespace"))).toBeUndefined();
    expect(locationOf(reading("github://o/r/w", "namespace"))?.identity).toBe("github.com/o/r");
    expect(namesOf(reading("https://github.com/o/r", "repo"))).toEqual([]);
  });

  /**
   * rangeOf should return the range of a recipe, a recipe file and a browsed
   * repository, and nothing for other kinds.
   *
   * rangeOf(recipe@^1) // -> "^1"
   */
  it("should return the range where a kind carries one", () => {
    expect(rangeOf(reading("w/a@^1", "recipe"))).toBe("^1");
    expect(rangeOf(reading("w/a/x.md@^2", "recipeFile"))).toBe("^2");
    expect(rangeOf(reading("w", "namespace"))).toBeUndefined();
  });
});
