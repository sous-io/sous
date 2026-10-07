import { describe, expect, it } from "vitest";
import { ConfigError } from "../errors.js";
import { compileRecipeKeyMatcher, isRegexSpelling } from "./recipe-key-matcher.js";

describe("isRegexSpelling()", () => {
  /**
   * isRegexSpelling should be true only for a string written between two slashes
   * with something between them.
   *
   * isRegexSpelling("/^a/"); // -> true
   * isRegexSpelling("a/b");  // -> false
   * isRegexSpelling("//");   // -> false
   */
  it("should recognise only the /.../ spelling", () => {
    expect(isRegexSpelling("/^a/")).toBe(true);
    expect(isRegexSpelling("a/b")).toBe(false);
    expect(isRegexSpelling("//")).toBe(false);
    expect(isRegexSpelling("/a")).toBe(false);
  });
});

describe("compileRecipeKeyMatcher()", () => {
  /**
   * A glob entry should match a recipe key the way a path glob does.
   *
   * compileRecipeKeyMatcher(["communication/*"], "k")("communication/tone"); // -> true
   * compileRecipeKeyMatcher(["communication/*"], "k")("workflow/tone");      // -> false
   */
  it("should match globs against recipe keys", () => {
    const matches = compileRecipeKeyMatcher(["communication/*"], "recipes.memories.first");
    expect(matches("communication/tone")).toBe(true);
    expect(matches("workflow/tone")).toBe(false);
  });

  /**
   * An entry written /.../ should be read as a regular expression.
   *
   * compileRecipeKeyMatcher(["/^tool-usage\\//"], "k")("tool-usage/browser"); // -> true
   */
  it("should read a /.../ entry as a regular expression", () => {
    const matches = compileRecipeKeyMatcher(["/^tool-usage\\//"], "recipes.memories.exclude");
    expect(matches("tool-usage/browser")).toBe(true);
    expect(matches("communication/tool-usage/x")).toBe(false);
  });

  /**
   * The matcher should be true when any one entry matches, and an empty or
   * missing list should match nothing.
   *
   * compileRecipeKeyMatcher(undefined, "k")("a/b"); // -> false
   */
  it("should match when any entry matches, and nothing for no entries", () => {
    const matches = compileRecipeKeyMatcher(["a/*", "/^b\\//"], "k");
    expect(matches("a/x")).toBe(true);
    expect(matches("b/x")).toBe(true);
    expect(matches("c/x")).toBe(false);
    expect(compileRecipeKeyMatcher(undefined, "k")("a/b")).toBe(false);
    expect(compileRecipeKeyMatcher([], "k")("a/b")).toBe(false);
  });

  /**
   * An invalid regular expression should be a ConfigError naming the key and the value.
   *
   * compileRecipeKeyMatcher(["/(/"], "recipes.memories.first");
   * // -> throws: The value "/(/" in 'recipes.memories.first' ...
   */
  it("should throw a ConfigError naming the key and value for a bad regular expression", () => {
    const build = () => compileRecipeKeyMatcher(["/(/"], "recipes.memories.first");
    expect(build).toThrow(ConfigError);
    expect(build).toThrow("'recipes.memories.first'");
    expect(build).toThrow('"/(/"');
  });
});
