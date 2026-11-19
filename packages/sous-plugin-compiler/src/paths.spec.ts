/**
 * The compiler's path helpers. The `destinationDir` cases are ported from today's
 * `src/lib/markdown-compiler.spec.ts`; `inferGlobBase` is `host.globs.staticBase` now. The
 * reference rules follow Claude Code's own (spec 17, "The Two Rules").
 */

import { describe, expect, it } from "vitest";
import { expandHome, importPath, isIncludableFile, isIncludeLine, isSousIncludeForm, resolveOutputPath, stableVarsFingerprint } from "./paths.js";

describe("importPath", () => {
    /** Claude Code's acceptance: `./`, `~/`, `/` (not alone), or a letter, digit, `.`, `_` or `-`. */
    it("should accept what Claude Code imports", () => {
        expect(importPath("x.md")).toBe("x.md");
        expect(importPath("./x.md")).toBe("./x.md");
        expect(importPath("~/notes.md")).toBe("~/notes.md");
        expect(importPath("/abs/x.md")).toBe("/abs/x.md");
        expect(importPath("-dash.md")).toBe("-dash.md");
        expect(importPath("_x.md")).toBe("_x.md");
        expect(importPath("README")).toBe("README");
        expect(importPath("https://example.com/x.md")).toBe("https://example.com/x.md");
    });

    /** The run is cut at its first `#`, and a backslash keeps the space after it. */
    it("should cut at # and keep an escaped space", () => {
        expect(importPath("x.md#section")).toBe("x.md");
        expect(importPath("my\\ file.md")).toBe("my file.md");
    });

    /** No trailing punctuation is stripped: it stays part of the path. */
    it("should keep trailing punctuation", () => {
        for (const run of ["x.md.", "x.md,", "x.md)", "x.md:", "x.md;", "x.md!", "x.md?"]) {
            expect(importPath(run), run).toBe(run);
        }
    });

    /** What Claude Code does not import. */
    it("should reject what Claude Code does not import", () => {
        for (const run of ["/", "\"x.md\"", "'x.md'", "@x.md", "#memories/x.md", "~ns/recipe/x.md", "${root}/x.md", "*.md", "(x.md)"]) {
            expect(importPath(run), run).toBeUndefined();
        }
    });
});

describe("isIncludableFile", () => {
    /** Claude Code's list, in lower case, or no extension. */
    it("should take the text types Claude Code imports, in any case, and files with no extension", () => {
        for (const file of ["/p/x.md", "/p/X.MD", "/p/x.txt", "/p/x.json", "/p/x.sh", "/p/README", "/p/.env", "/p/x.tpl.md", "/p/x.R"]) {
            expect(isIncludableFile(file), file).toBe(true);
        }

        for (const file of ["/p/logo.png", "/p/x.pdf", "/p/x.zip", "/p/x.bak"]) {
            expect(isIncludableFile(file), file).toBe(false);
        }
    });
});

describe("isSousIncludeForm", () => {
    /** Sous's own forms, taken only from a line of their own. */
    it("should recognise Sous's own forms", () => {
        for (const word of ["~ns/r/x.md", "~other-repo:ns/r/x.md", "#project/x.md", "#memories/**/*.md", "${root}/x.md", "parts/*.md", "a*b*.md", "x.md?mood=calm"]) {
            expect(isSousIncludeForm(word), word).toBe(true);
        }
    });

    /** Plain paths, `~/` among them, are not Sous forms. */
    it("should leave plain paths to Claude Code's rule", () => {
        for (const word of ["x.md", "~/x.md", "./x.md", "/abs/x.md", "docs:x.md", "README", "x.md#section"]) {
            expect(isSousIncludeForm(word), word).toBe(false);
        }
    });
});

describe("isIncludeLine", () => {
    /** A line holding only `@` and a Sous form or a path Claude Code accepts. */
    it("should accept a line holding one include", () => {
        for (const line of ["@a.md", "@./x.md", "@~ns/r/x.md", "@#project/x.md", "@${root}/x.md", "@parts/*.md", "@x.md?mood=calm", "@/abs/path/x.md", "@a.txt", "@README", "@x.md  "]) {
            expect(isIncludeLine(line), line).toBe(true);
        }

        for (const line of ["@a.md extra", "a.md", "  @a.md", "@\"x.md\"", "@@x.md", "@"]) {
            expect(isIncludeLine(line), line).toBe(false);
        }
    });
});

describe("resolveOutputPath", () => {
    /** With a `globBase`, the source's path under it is mirrored under the directory. */
    it("mirrors source subdirectory structure under destinationDir when globBase is set", () => {
        expect(resolveOutputPath({ source: "/t/src/subdir/skill.md", globBase: "/t/src" }, { destinationDir: "/t/dest" })).toBe("/t/dest/subdir/skill.md");
    });

    /** Without one, only the file name is kept. */
    it("falls back to basename when globBase is not set", () => {
        expect(resolveOutputPath({ source: "/t/src/subdir/skill.md" }, { destinationDir: "/t/dest" })).toBe("/t/dest/skill.md");
    });

    /** `.tpl.` comes out of the name. */
    it("strips .tpl. from the output filename when globBase is set", () => {
        expect(resolveOutputPath({ source: "/t/src/subdir/entry.tpl.md", globBase: "/t/src" }, { destinationDir: "/t/dest" })).toBe("/t/dest/subdir/entry.md");
    });

    /** A destination file is used as it is; an output naming neither writes nothing. */
    it("uses a destinationFile as it is, and gives nothing for neither", () => {
        expect(resolveOutputPath({ source: "/a.tpl.md" }, { destinationFile: "/out/a.tpl.md", destinationDir: "/x" })).toBe("/out/a.tpl.md");
        expect(resolveOutputPath({ source: "/a.md" }, {})).toBeUndefined();
    });
});

describe("small helpers", () => {
    /** `~` and `~/` expand to the home directory; nothing else changes. */
    it("should expand a leading ~", () => {
        expect(expandHome("~/x", "/h")).toBe("/h/x");
        expect(expandHome("~", "/h")).toBe("/h");
        expect(expandHome("~ns/x", "/h")).toBe("~ns/x");
    });

    /** A scope's fingerprint ignores key order. */
    it("should fingerprint a scope whatever its key order", () => {
        expect(stableVarsFingerprint({ b: "2", a: "1" })).toBe(stableVarsFingerprint({ a: "1", b: "2" }));
    });
});
