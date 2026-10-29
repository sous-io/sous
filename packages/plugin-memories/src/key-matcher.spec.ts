import { describe, expect, it } from "vitest";
import { minimatch } from "minimatch";
import { ConfigError } from "@sous-io/plugin-api";
import { compileRecipeKeyFinder, compileRecipeKeyMatcher, isRegexSpelling } from "./key-matcher.js";

const isMatch = (key: string, pattern: string) => minimatch(key, pattern);

describe("isRegexSpelling()", () => {
    /**
     * Only a string written between two slashes, with something between them, is a regular expression.
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
     * A glob entry matches a recipe key the way a path glob does.
     *
     * compileRecipeKeyMatcher(["communication/*"], "k", isMatch)("communication/tone"); // -> true
     */
    it("should match globs against recipe keys", () => {
        const matches = compileRecipeKeyMatcher(["communication/*"], "recipes.memories.first", isMatch);

        expect(matches("communication/tone")).toBe(true);
        expect(matches("workflow/tone")).toBe(false);
    });

    /**
     * An entry written /.../ is read as a regular expression.
     *
     * compileRecipeKeyMatcher(["/^tool-usage\\//"], "k", isMatch)("tool-usage/browser"); // -> true
     */
    it("should read a /.../ entry as a regular expression", () => {
        const matches = compileRecipeKeyMatcher(["/^tool-usage\\//"], "recipes.memories.exclude", isMatch);

        expect(matches("tool-usage/browser")).toBe(true);
        expect(matches("communication/tool-usage/x")).toBe(false);
    });

    /**
     * The matcher is true when any entry matches; an empty or missing list matches nothing.
     *
     * compileRecipeKeyMatcher(undefined, "k", isMatch)("a/b"); // -> false
     */
    it("should match when any entry matches, and nothing for no entries", () => {
        const matches = compileRecipeKeyMatcher(["a/*", "/^b\\//"], "k", isMatch);

        expect(matches("a/x")).toBe(true);
        expect(matches("b/x")).toBe(true);
        expect(matches("c/x")).toBe(false);
        expect(compileRecipeKeyMatcher(undefined, "k", isMatch)("a/b")).toBe(false);
        expect(compileRecipeKeyMatcher([], "k", isMatch)("a/b")).toBe(false);
    });

    /**
     * An invalid regular expression is a ConfigError naming the key and the value.
     *
     * compileRecipeKeyMatcher(["/(/"], "recipes.memories.first", isMatch);
     * // -> throws: The value "/(/" in 'recipes.memories.first' ...
     */
    it("should throw a ConfigError naming the key and value for a bad regular expression", () => {
        const build = () => compileRecipeKeyMatcher(["/(/"], "recipes.memories.first", isMatch);

        expect(build).toThrow(ConfigError);
        expect(build).toThrow("'recipes.memories.first'");
        expect(build).toThrow('"/(/"');
    });
});

describe("compileRecipeKeyFinder()", () => {
    /**
     * The finder names the first entry that matched, as a config path.
     *
     * compileRecipeKeyFinder(["a/*", "b/*"], "recipes.memories.exclude", isMatch)("b/x");
     * // -> "recipes.memories.exclude[1]"
     */
    it("should name the entry that matched", () => {
        const find = compileRecipeKeyFinder(["a/*", "b/*"], "recipes.memories.exclude", isMatch);

        expect(find("b/x")).toBe("recipes.memories.exclude[1]");
        expect(find("c/x")).toBeUndefined();
    });
});
