import { describe, expect, it } from "vitest";
import { editDistance, suggest, toKebab } from "./words.js";

describe("toKebab()", () => {
    /**
     * toKebab turns an input field name into its flag name.
     *
     * toKebab("installPlugins"); // -> "install-plugins"
     */
    it("should turn camel case and underscores into kebab case", () => {
        expect(toKebab("installPlugins")).toBe("install-plugins");
        expect(toKebab("dry_run")).toBe("dry-run");
        expect(toKebab("json")).toBe("json");
    });
});

describe("editDistance()", () => {
    /**
     * editDistance counts the single-character edits between two words.
     *
     * editDistance("buld", "build"); // -> 1
     */
    it("should count insertions, deletions and substitutions", () => {
        expect(editDistance("buld", "build")).toBe(1);
        expect(editDistance("", "abc")).toBe(3);
        expect(editDistance("kitten", "sitting")).toBe(3);
        expect(editDistance("same", "same")).toBe(0);
    });
});

describe("suggest()", () => {
    /**
     * suggest returns up to three close words, closest first, then by name.
     *
     * suggest("buld", ["build", "bundle", "init"]); // -> ["build"]
     */
    it("should suggest the closest words, best first", () => {
        expect(suggest("buld", ["build", "bundle", "init"])).toEqual(["build"]);
        expect(suggest("rpeo", ["repo", "recipe"])).toEqual(["repo"]);
        expect(suggest("zzzzzz", ["build"])).toEqual([]);
    });

    /**
     * suggest also offers words that start with what was typed, after the close ones.
     *
     * suggest("sub", ["subscription"]); // -> ["subscription"]
     */
    it("should suggest words that start with what was typed", () => {
        expect(suggest("sub", ["subscription", "build"])).toEqual(["subscription"]);
        expect(suggest("a", ["abcdef"])).toEqual([]);
    });

    /** suggest gives at most three words and ignores repeats. */
    it("should give at most three words and ignore repeats", () => {
        expect(suggest("ab", ["aa", "ab", "ac", "ad", "ab"])).toEqual(["ab", "aa", "ac"]);
    });
});
