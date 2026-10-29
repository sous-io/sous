import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostGlobs } from "./globs.js";

describe("staticBase()", () => {
    /** The static prefix before the first glob segment is the base (ported from inferGlobBase). */
    it.each([
        ["/foo/bar/**/*", "/foo/bar"],
        ["/foo/bar/*/baz.md", "/foo/bar"],
        ["/foo/bar/baz?.md", "/foo/bar"],
        ["/foo/bar/{a,b}/*.md", "/foo/bar"],
        ["/foo/bar/[abc]/*.md", "/foo/bar"],
        ["/**/*", "/"],
        ["/*/bar.md", "/"],
        ["/foo/bar/", "/foo/bar"],
        ["/foo/bar/file.md", "/foo/bar/file.md"],
        ["docs/**/*.md", "docs"],
        ["*.md", "/"],
    ])("should give the base of %s", (pattern, base) => {
        expect(hostGlobs.staticBase(pattern)).toBe(base);
    });
});

describe("hasGlob()", () => {
    /** Every glob character is seen; plain names are not globs. */
    it("should recognize glob syntax", () => {
        for (const text of ["*", "a?", "[ab]", "{a,b}", "**"]) expect(hostGlobs.hasGlob(text)).toBe(true);
        expect(hostGlobs.hasGlob("plain-name")).toBe(false);
    });
});

describe("bytewise order", () => {
    /** Capitals sort before lowercase, whatever the locale. */
    it("should order by UTF-8 bytes", () => {
        expect(hostGlobs.sortBytewise(["b", "B", "a"])).toEqual(["B", "a", "b"]);
        expect(hostGlobs.compareBytewise("a", "b")).toBeLessThan(0);
        expect(hostGlobs.compareBytewise("é", "z")).toBeGreaterThan(0);
        expect(hostGlobs.compareBytewise("same", "same")).toBe(0);
    });

    /** Sorting leaves its input alone. */
    it("should return a copy", () => {
        const input = ["b", "a"];

        hostGlobs.sortBytewise(input);

        expect(input).toEqual(["b", "a"]);
    });
});

describe("isMatch()", () => {
    /** Patterns match paths; a list matches when any pattern does. */
    it("should match one or several patterns", () => {
        expect(hostGlobs.isMatch("docs/a.md", "docs/**/*.md")).toBe(true);
        expect(hostGlobs.isMatch("docs/a.txt", ["docs/*.md", "docs/*.txt"])).toBe(true);
        expect(hostGlobs.isMatch(".hidden", "*")).toBe(false);
        expect(hostGlobs.isMatch(".hidden", "*", { dot: true })).toBe(true);
        expect(hostGlobs.isMatch("README", "readme")).toBe(false);
        expect(hostGlobs.isMatch("README", "readme", { nocase: true })).toBe(true);
    });
});

describe("files and containment", () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(path.join(tmpdir(), "host-globs-"));
        mkdirSync(path.join(root, "docs", "deep"), { recursive: true });
        mkdirSync(path.join(root, "outside"));
        for (const file of ["docs/b.md", "docs/B.md", "docs/a.md", "docs/deep/c.md", "docs/.dot.md"]) {
            writeFileSync(path.join(root, file), "x");
        }
    });

    afterEach(() => rmSync(root, { recursive: true, force: true }));

    /** Matches come back relative, with `/`, in bytewise order. */
    it("should match files in bytewise order", async () => {
        const matches = await hostGlobs.match("docs/**/*.md", { cwd: root });

        expect(matches).toEqual(["docs/B.md", "docs/a.md", "docs/b.md", "docs/deep/c.md"]);
        expect(hostGlobs.matchSync("docs/**/*.md", { cwd: root })).toEqual(matches);
    });

    /** Dot files, absolute paths and ignores follow their options. */
    it("should honour dot, absolute and ignore", async () => {
        expect(await hostGlobs.match("docs/*.md", { cwd: root, dot: true, ignore: ["docs/b.md"] })).toEqual(["docs/.dot.md", "docs/B.md", "docs/a.md"]);
        expect(await hostGlobs.match("docs/a.md", { cwd: root, absolute: true })).toEqual([path.join(root, "docs/a.md")]);
        expect(await hostGlobs.match(["docs/a.md", "docs/b.md"], { cwd: root })).toEqual(["docs/a.md", "docs/b.md"]);
    });

    /** Directories come back only when asked for. */
    it("should return directories when onlyFiles is off", async () => {
        expect(await hostGlobs.match("docs/*", { cwd: root, onlyFiles: false, ignore: ["docs/*.md"] })).toEqual(["docs/deep"]);
    });

    /** Text containment: the path itself, a descendant, but not a sibling with the same prefix. */
    it("should say whether a path is inside another", () => {
        expect(hostGlobs.isInside("/a/b", "/a/b")).toBe(true);
        expect(hostGlobs.isInside("/a/b/c", "/a/b")).toBe(true);
        expect(hostGlobs.isInside("/a/bc", "/a/b")).toBe(false);
        expect(hostGlobs.isInside("/a/b/../c", "/a/b")).toBe(false);
        expect(hostGlobs.isInside("/a/b/..x", "/a/b")).toBe(true);
    });

    /** A link that leads out of the directory is outside once links are followed. */
    it("should follow links with realPath", () => {
        symlinkSync(path.join(root, "outside"), path.join(root, "docs", "escape"));
        symlinkSync(path.join(root, "docs", "deep"), path.join(root, "docs", "within"));
        const escape = path.join(root, "docs", "escape");
        const within = path.join(root, "docs", "within");
        const docs = path.join(root, "docs");

        expect(hostGlobs.isInside(escape, docs)).toBe(true);
        expect(hostGlobs.isInside(escape, docs, { realPath: true })).toBe(false);
        expect(hostGlobs.isInside(within, docs, { realPath: true })).toBe(true);
    });

    /** The real path comes back when inside; a missing file in a good directory still counts as inside. */
    it("should give the real path inside a root", () => {
        symlinkSync(path.join(root, "outside"), path.join(root, "docs", "escape"));
        const docs = path.join(root, "docs");

        expect(hostGlobs.realPathInside(path.join(docs, "a.md"), docs)).toBe(path.join(docs, "a.md"));
        expect(hostGlobs.realPathInside(path.join(docs, "escape"), docs)).toBeUndefined();
        expect(hostGlobs.realPathInside(path.join(docs, "missing.md"), docs)).toBe(path.join(docs, "missing.md"));
        expect(hostGlobs.realPathInside(path.join(docs, "missing.md"), path.join(root, "nowhere", "at", "all"))).toBeUndefined();
    });

    /** Separators become `/`. */
    it("should make posix paths", () => {
        expect(hostGlobs.toPosix(["a", "b"].join(path.sep))).toBe("a/b");
    });
});
