import { describe, it, expect } from "vitest";
import {
  formatRef,
  isNamespaceRef,
  isValidRef,
  parseRef,
  refKey,
  tryParseRef,
} from "./ref.js";
import { isConfigError } from "../errors.js";

/**
 * Unit tests for the ref parser. Refs name a namespace or a recipe everywhere
 * in the Repositories system, so every grammar branch and every rejection
 * message is covered here.
 */

/** Runs parseRef and returns the ConfigError message, or fails the test. */
function expectRejectMessage(input: string): string {
  try {
    parseRef(input);
  } catch (error) {
    expect(isConfigError(error)).toBe(true);
    return (error as Error).message;
  }
  throw new Error(`expected parseRef(${JSON.stringify(input)}) to throw, but it returned`);
}

describe("parseRef()", () => {
  /**
   * A single segment is a namespace ref, which names every recipe in that
   * namespace, including ones published later.
   *
   * parseRef("workflow");  // -> { namespace: "workflow" }
   */
  it("should parse a bare namespace", () => {
    expect(parseRef("workflow")).toEqual({ namespace: "workflow" });
  });

  /**
   * Two segments name one recipe inside a namespace.
   *
   * parseRef("workflow/task-files");
   * // -> { namespace: "workflow", recipe: "task-files" }
   */
  it("should parse a namespace and recipe", () => {
    expect(parseRef("workflow/task-files")).toEqual({
      namespace: "workflow",
      recipe: "task-files",
    });
  });

  /**
   * An `@` introduces a version range, which follows npm's rules.
   *
   * parseRef("workflow/task-files@^1.2.0");
   * // -> { namespace: "workflow", recipe: "task-files", range: "^1.2.0" }
   */
  it("should parse a recipe with a version range", () => {
    expect(parseRef("workflow/task-files@^1.2.0")).toEqual({
      namespace: "workflow",
      recipe: "task-files",
      range: "^1.2.0",
    });
  });

  /**
   * A range containing spaces stays intact; only the whole ref is trimmed.
   *
   * parseRef("workflow/task-files@>=1.0.0 <2.0.0").range;  // -> ">=1.0.0 <2.0.0"
   */
  it("should keep the spaces inside a compound range", () => {
    expect(parseRef("workflow/task-files@>=1.0.0 <2.0.0").range).toBe(">=1.0.0 <2.0.0");
  });

  /**
   * A `repo:` qualifier disambiguates a ref that resolves in more than one
   * added repo. It may qualify a namespace ref as well as a recipe ref.
   *
   * parseRef("sous-recipes:workflow/task-files@~2.1");
   * // -> { repo: "sous-recipes", namespace: "workflow", recipe: "task-files", range: "~2.1" }
   */
  it("should parse a repo qualifier on every ref shape", () => {
    expect(parseRef("sous-recipes:workflow/task-files@~2.1")).toEqual({
      repo: "sous-recipes",
      namespace: "workflow",
      recipe: "task-files",
      range: "~2.1",
    });
    expect(parseRef("sous-recipes:workflow")).toEqual({
      repo: "sous-recipes",
      namespace: "workflow",
    });
  });

  /**
   * Surrounding whitespace is insignificant, so a ref pasted from a document
   * still parses.
   *
   * parseRef("  workflow/task-files  ");
   * // -> { namespace: "workflow", recipe: "task-files" }
   */
  it("should trim surrounding whitespace", () => {
    expect(parseRef("  workflow/task-files  ")).toEqual({
      namespace: "workflow",
      recipe: "task-files",
    });
  });

  /**
   * The wildcard range is a valid range, so it parses rather than being treated
   * as a missing one.
   */
  it("should accept the wildcard range", () => {
    expect(parseRef("workflow/task-files@*").range).toBe("*");
  });
});

describe("parseRef() rejections", () => {
  /**
   * An empty ref, or one that is only whitespace, is rejected.
   */
  it("should reject an empty ref", () => {
    expect(expectRejectMessage("")).toContain("must not be empty");
    expect(expectRejectMessage("   ")).toContain("must not be empty");
  });

  /**
   * `@` was explicitly rejected as a namespace prefix during design, because it
   * collides with include syntax and overloads the version separator. The error
   * says so and points at the range syntax.
   *
   * parseRef("@workflow");  // throws: refs take no '@' prefix
   */
  it("should reject an @ prefix and point at the range syntax", () => {
    const message = expectRejectMessage("@workflow/task-files");
    expect(message).toContain("refs take no '@' prefix");
    expect(message).toContain("introduces a version range only");
  });

  /**
   * `~` is the template include sigil, not a ref prefix, and the error says
   * where it does belong.
   *
   * parseRef("~workflow");  // throws: refs take no '~' prefix
   */
  it("should reject a ~ prefix and point at the include sigil", () => {
    const message = expectRejectMessage("~workflow");
    expect(message).toContain("refs take no '~' prefix");
    expect(message).toContain("template include");
  });

  /**
   * A namespace is not versioned, so a range on a namespace ref is rejected
   * with a message saying to name a recipe.
   *
   * parseRef("workflow@^1.0.0");  // throws
   */
  it("should reject a version range on a namespace ref", () => {
    const message = expectRejectMessage("workflow@^1.0.0");
    expect(message).toContain("namespaces are not versioned");
  });

  /**
   * A range that semver does not recognize is rejected, quoting the range.
   */
  it("should reject a range semver does not recognize", () => {
    const message = expectRejectMessage("workflow/task-files@not a range");
    expect(message).toContain("'not a range' is not a version range");
  });

  /**
   * A trailing `@` with nothing after it is a mistake, not an empty range.
   */
  it("should reject a trailing @ with no range", () => {
    expect(expectRejectMessage("workflow/task-files@")).toContain(
      "not followed by a version range"
    );
  });

  /**
   * Only one range is allowed; a second `@` is rejected rather than folded into
   * the range text.
   */
  it("should reject a second @", () => {
    expect(expectRejectMessage("workflow/task-files@1.0.0@2.0.0")).toContain(
      "at most one '@' version range"
    );
  });

  /**
   * Only one repo qualifier is allowed.
   */
  it("should reject a second repo qualifier", () => {
    expect(expectRejectMessage("a:b:workflow")).toContain("at most one 'repo:' qualifier");
  });

  /**
   * An empty repo qualifier is rejected rather than read as no qualifier.
   */
  it("should reject an empty repo qualifier", () => {
    expect(expectRejectMessage(":workflow")).toContain("repo qualifier before ':' is empty");
  });

  /**
   * A repo qualifier that is not kebab-case is rejected, quoting it.
   */
  it("should reject a repo qualifier that is not kebab-case", () => {
    expect(expectRejectMessage("Sous_Recipes:workflow")).toContain(
      "the repo qualifier 'Sous_Recipes' must be lowercase kebab-case"
    );
  });

  /**
   * Refs have at most two path segments; a third is rejected explicitly rather
   * than being read as a longer recipe name.
   */
  it("should reject a third path segment", () => {
    expect(expectRejectMessage("a/b/c")).toContain("at most two path segments");
  });

  /**
   * An empty namespace or an empty recipe name is rejected with a message
   * naming which one is missing.
   */
  it("should reject empty path segments", () => {
    expect(expectRejectMessage("/task-files")).toContain("the namespace is empty");
    expect(expectRejectMessage("workflow/")).toContain("the recipe name after '/' is empty");
  });

  /**
   * Namespace and recipe names are lowercase kebab-case, and the message quotes
   * the offending segment.
   */
  it("should reject segments that are not kebab-case", () => {
    expect(expectRejectMessage("Workflow")).toContain(
      "the namespace 'Workflow' must be lowercase kebab-case"
    );
    expect(expectRejectMessage("workflow/Task_Files")).toContain(
      "the recipe name 'Task_Files' must be lowercase kebab-case"
    );
    expect(expectRejectMessage("workflow/task files")).toContain(
      "must be lowercase kebab-case"
    );
  });

  /**
   * Every rejection carries the one-line grammar reminder, so a user never has
   * to go looking for the syntax.
   */
  it("should show the grammar on every rejection", () => {
    expect(expectRejectMessage("Workflow")).toContain(
      "A ref is written as 'namespace', 'namespace/recipe'"
    );
  });
});

describe("tryParseRef() and isValidRef()", () => {
  /**
   * tryParseRef returns undefined instead of throwing, for callers that report
   * the problem another way (a zod issue, for instance).
   *
   * tryParseRef("Workflow");  // -> undefined
   */
  it("should return undefined rather than throw for a bad ref", () => {
    expect(tryParseRef("workflow")).toEqual({ namespace: "workflow" });
    expect(tryParseRef("Workflow")).toBeUndefined();
  });

  /**
   * isValidRef is the boolean form.
   *
   * isValidRef("workflow/task-files@^1.0.0");  // -> true
   */
  it("should report validity as a boolean", () => {
    expect(isValidRef("workflow/task-files@^1.0.0")).toBe(true);
    expect(isValidRef("workflow@^1.0.0")).toBe(false);
  });
});

describe("formatRef()", () => {
  /**
   * formatRef renders a parsed ref back to its written form, round-tripping
   * with parseRef.
   *
   * formatRef(parseRef("sous-recipes:workflow/task-files@^1.2.0"));
   * // -> "sous-recipes:workflow/task-files@^1.2.0"
   */
  it("should round-trip every ref shape", () => {
    for (const input of [
      "workflow",
      "workflow/task-files",
      "workflow/task-files@^1.2.0",
      "sous-recipes:workflow",
      "sous-recipes:workflow/task-files@>=1.0.0 <2.0.0",
    ]) {
      expect(formatRef(parseRef(input))).toBe(input);
    }
  });
});

describe("refKey()", () => {
  /**
   * refKey drops the repo qualifier and the range, leaving the identity a
   * subscription, index entry or lockfile entry is stored under.
   *
   * refKey(parseRef("sous-recipes:workflow/task-files@^1.2.0"));
   * // -> "workflow/task-files"
   */
  it("should drop the repo qualifier and the range", () => {
    expect(refKey(parseRef("sous-recipes:workflow/task-files@^1.2.0"))).toBe(
      "workflow/task-files"
    );
    expect(refKey(parseRef("sous-recipes:workflow"))).toBe("workflow");
  });
});

describe("isNamespaceRef()", () => {
  /**
   * isNamespaceRef distinguishes a whole-namespace subscription from a single
   * recipe.
   *
   * isNamespaceRef(parseRef("workflow"));  // -> true
   */
  it("should be true only when no recipe is named", () => {
    expect(isNamespaceRef(parseRef("workflow"))).toBe(true);
    expect(isNamespaceRef(parseRef("workflow/task-files"))).toBe(false);
  });
});
