import { describe, expect, it } from "vitest";
import { formatPath, isPathPrefix, parsePath, pathsOverlap, PathSyntaxError } from "./path.js";

describe("parsePath()", () => {
    /**
     * parsePath should split a dotted string into its keys.
     *
     * parsePath("compilation.includeSourceComments");
     * // -> ["compilation", "includeSourceComments"]
     */
    it("should split a dotted path into keys", () => {
        expect(parsePath("compilation.includeSourceComments")).toEqual(["compilation", "includeSourceComments"]);
    });

    /**
     * parsePath should read `[n]` as an array index (a number) and quoted keys as JSON strings.
     *
     * parsePath('subscriptions."workflow/x".targets[7].id');
     * // -> ["subscriptions", "workflow/x", "targets", 7, "id"]
     */
    it("should read indexes as numbers and quoted keys as strings", () => {
        expect(parsePath('subscriptions."workflow/x".targets[7].id')).toEqual(["subscriptions", "workflow/x", "targets", 7, "id"]);
        expect(parsePath('a["b.c"]')).toEqual(["a", "b.c"]);
        expect(parsePath('a[ "b" ]')).toEqual(["a", "b"]);
        expect(parsePath('"a\\"b".c')).toEqual(['a"b', "c"]);
        expect(parsePath("[0][1]")).toEqual([0, 1]);
        expect(parsePath("a.[2]")).toEqual(["a", 2]);
    });

    /**
     * parsePath should treat the empty string and the empty array as the root.
     *
     * parsePath("");   // -> []
     */
    it("should read the root as no segments", () => {
        expect(parsePath("")).toEqual([]);
        expect(parsePath([])).toEqual([]);
    });

    /**
     * parsePath should copy and check an array of segments.
     *
     * parsePath(["a", 0]);   // -> ["a", 0]
     * parsePath(["a", -1]);  // throws PathSyntaxError
     */
    it("should accept segment arrays and reject bad segments", () => {
        const input = ["a", 0] as const;
        const out = parsePath(input);

        expect(out).toEqual(["a", 0]);
        expect(out).not.toBe(input);
        expect(() => parsePath(["a", -1])).toThrow(PathSyntaxError);
        expect(() => parsePath(["a", 1.5])).toThrow(PathSyntaxError);
        expect(() => parsePath([true as unknown as string])).toThrow(PathSyntaxError);
    });

    /**
     * parsePath should return a fresh array even for a cached string, so callers may change it.
     */
    it("should return a fresh array every time", () => {
        const first = parsePath("a.b");

        first.push("c");
        expect(parsePath("a.b")).toEqual(["a", "b"]);
    });

    /**
     * parsePath should name what is wrong with a malformed path.
     *
     * parsePath("a..b");   // throws: The path "a..b" has an empty key (at character 3).
     */
    it("should reject malformed paths with a plain message", () => {
        expect(() => parsePath("a..b")).toThrow("has an empty key");
        expect(() => parsePath(".a")).toThrow("has an empty key");
        expect(() => parsePath("a.")).toThrow("ends with a dot");
        expect(() => parsePath("a[1")).toThrow("no closing ]");
        expect(() => parsePath("a[x]")).toThrow("neither an index nor a quoted key");
        expect(() => parsePath('a."b')).toThrow("no closing quote");
        expect(() => parsePath('a["b]')).toThrow("no closing ]");
        expect(() => parsePath('a["\\x"]')).toThrow("not a valid JSON string");
        expect(() => parsePath("a[0]b")).toThrow("needs a dot");
        expect(() => parsePath('"a"b')).toThrow("needs a dot");
    });

    /**
     * parsePath should keep working after its cache of parsed strings fills up.
     */
    it("should keep parsing correctly after the cache is cleared", () => {
        for (let i = 0; i < 5002; i++) {
            parsePath(`key${i}.x`);
        }

        expect(parsePath("key1.x")).toEqual(["key1", "x"]);
    });
});

describe("formatPath()", () => {
    /**
     * formatPath should write the canonical form: bare keys, quoted keys when needed, `[n]` indexes.
     *
     * formatPath(["subscriptions", "workflow/x", "targets", 7]);
     * // -> 'subscriptions."workflow/x".targets[7]'
     */
    it("should write the canonical path string", () => {
        expect(formatPath(["subscriptions", "workflow/x", "targets", 7])).toBe('subscriptions."workflow/x".targets[7]');
        expect(formatPath(["_vars", "config-files", "a.b", ""])).toBe('_vars.config-files."a.b".""');
        expect(formatPath([0, "a"])).toBe("[0].a");
        expect(formatPath([])).toBe("");
    });

    /**
     * formatPath and parsePath should round-trip any segments.
     */
    it("should round-trip through parsePath", () => {
        const segments = ["a b", 3, 'q"uote', "x", 0, "tool-usage/automated-browser-tasks"];

        expect(parsePath(formatPath(segments))).toEqual(segments);
    });
});

describe("isPathPrefix()", () => {
    /**
     * isPathPrefix should be true for the path itself and the paths above it, only.
     *
     * isPathPrefix(["a"], ["a", "b"]);   // -> true
     */
    it("should tell a path above another apart from one below or beside it", () => {
        expect(isPathPrefix([], ["a"])).toBe(true);
        expect(isPathPrefix(["a"], ["a", "b"])).toBe(true);
        expect(isPathPrefix(["a", "b"], ["a", "b"])).toBe(true);
        expect(isPathPrefix(["a", "b"], ["a"])).toBe(false);
        expect(isPathPrefix(["a", "c"], ["a", "b"])).toBe(false);
        expect(isPathPrefix([0], ["0"])).toBe(false);
    });
});

describe("pathsOverlap()", () => {
    /**
     * pathsOverlap should be true when either path is above (or is) the other.
     *
     * pathsOverlap(["a", "b"], ["a"]);   // -> true
     */
    it("should be true in either direction and false for siblings", () => {
        expect(pathsOverlap(["a", "b"], ["a"])).toBe(true);
        expect(pathsOverlap(["a"], ["a", "b"])).toBe(true);
        expect(pathsOverlap(["a", "b"], ["a", "c"])).toBe(false);
    });
});
