import { describe, expect, it } from "vitest";
import { formatRef } from "./format.js";
import {
  isNamedRef,
  namespaceOfKey,
  namespaceRef,
  parseNamedRef,
  recipeRef,
  splitRecipeKey,
  withRepoName,
} from "./named-refs.js";
import { locationOf, repoOf } from "./parts.js";
import { shortKey } from "./pruners/rule-helpers.js";
import { RefSource } from "./source.js";

describe("parseNamedRef()", () => {
  /**
   * parseNamedRef returns the one namespace or recipe a short ref names, and
   * refuses a location.
   *
   * parseNamedRef("workflow/alpha", RefSource.Config) // -> the recipe workflow/alpha
   * parseNamedRef("github://o/r/workflow")            // throws, naming a location
   */
  it("should return the short reading and refuse a location", () => {
    const recipe = parseNamedRef("workflow/alpha", RefSource.Config);
    expect(recipe).toMatchObject({ kind: "recipe", name: "alpha" });
    expect(shortKey(recipe)).toBe("workflow/alpha");
    expect(() => parseNamedRef("github://o/r/workflow")).toThrow(/names a location/);
  });

  /**
   * A bare word on the command line also reads as a repository, a variable and
   * an environment variable name; the one short reading is still the namespace.
   *
   * parseNamedRef("workflow") // -> the namespace workflow
   */
  it("should find the one short reading among the other kinds a word could be", () => {
    expect(parseNamedRef("workflow")).toMatchObject({ kind: "namespace", name: "workflow" });
  });

  /**
   * The repository qualifier and the range are kept where the place allows them.
   *
   * parseNamedRef("repo:workflow/alpha@^1") // -> repo "repo", range "^1"
   */
  it("should keep the qualifier and the range", () => {
    const ref = parseNamedRef("repo:workflow/alpha@^1");
    expect(repoOf(ref)?.name).toBe("repo");
    expect(formatRef(ref)).toBe("repo:workflow/alpha@^1");
  });
});

describe("splitRecipeKey() and namespaceOfKey()", () => {
  /**
   * A stored key splits into its namespace and name through the one parser.
   *
   * splitRecipeKey("workflow/alpha") // -> { namespace: "workflow", name: "alpha" }
   */
  it("should split a stored key", () => {
    expect(splitRecipeKey("workflow/alpha")).toEqual({ namespace: "workflow", name: "alpha" });
    expect(namespaceOfKey("workflow/alpha")).toBe("workflow");
    expect(namespaceOfKey("workflow")).toBe("workflow");
  });

  /**
   * A namespace alone is not a recipe key.
   *
   * splitRecipeKey("workflow") // throws
   */
  it("should refuse a namespace as a recipe key", () => {
    expect(() => splitRecipeKey("workflow")).toThrow(/names a namespace and a recipe/);
  });

  /**
   * A stored key that is not in the stored form is refused in the place's own
   * words, saying what to write instead.
   *
   * namespaceOfKey("Workflow") // throws "stored names are lowercase"
   */
  it("should refuse a key that is not in the stored form", () => {
    expect(() => namespaceOfKey("Workflow")).toThrow(/lowercase/);
    expect(() => splitRecipeKey("github://o/r/workflow/alpha")).toThrow(/stored key/);
  });
});

describe("builders", () => {
  /**
   * The builders make the same refs the parser does, parents nested.
   *
   * recipeRef("workflow", "alpha", { repo: "r", range: "^1" }) // -> r:workflow/alpha@^1
   */
  it("should build a namespace and a recipe with their parents", () => {
    expect(formatRef(namespaceRef("workflow"))).toBe("workflow");
    expect(formatRef(namespaceRef("workflow", "r"))).toBe("r:workflow");
    expect(formatRef(recipeRef("workflow", "alpha"))).toBe("workflow/alpha");
    expect(formatRef(recipeRef("workflow", "alpha", { repo: "r", range: "^1" }))).toBe(
      "r:workflow/alpha@^1"
    );
    expect(isNamedRef(recipeRef("w", "a"))).toBe(true);
    expect(isNamedRef({ kind: "recipe", name: "a" })).toBe(false);
    expect(isNamedRef({ kind: "repo", name: "r" })).toBe(false);
  });

  /**
   * withRepoName qualifies a namespace or a recipe by a repository's short
   * name, and leaves a ref alone when there is none.
   *
   * withRepoName(recipeRef("w", "a"), "r") // -> r:w/a
   */
  it("should qualify a ref by a repository's short name", () => {
    expect(formatRef(withRepoName(recipeRef("w", "a", { range: "^1" }), "r"))).toBe("r:w/a@^1");
    expect(formatRef(withRepoName(namespaceRef("w"), "r"))).toBe("r:w");
    const plain = recipeRef("w", "a");
    expect(withRepoName(plain, undefined)).toBe(plain);
    expect(locationOf(withRepoName(plain, "r"))).toBeUndefined();
  });
});
