/**
 * The compiler's path helpers. The `looksLikeIncludeLine` and `destinationDir` cases are ported from
 * today's `src/lib/markdown-compiler.spec.ts`; `inferGlobBase` is `host.globs.staticBase` now.
 */

import { describe, expect, it } from "vitest";
import { expandHome, isIncludeLine, looksLikeIncludeLine, resolveOutputPath, stableVarsFingerprint } from "./paths.js";

describe("looksLikeIncludeLine", () => {
    /** A single path-like word starting with `@` looks like an include. */
    it("should accept a single path-like word", () => {
        for (const line of ["@docs/notes.txt", "@notes.md.bak", "@~workflow/x", "@#project", "@./x", "@${root}"]) {
            expect(looksLikeIncludeLine(line), line).toBe(true);
        }
    });

    /** Prose that merely starts with `@` is left alone. */
    it("should reject ordinary prose", () => {
        for (const line of ["@alice thanks for the review", "@alice", "@bob,", "@", "@a b/c", "text @x/y"]) {
            expect(looksLikeIncludeLine(line), line).toBe(false);
        }
    });
});

describe("isIncludeLine", () => {
    /** An include is `@`, a path ending in `.md`, and an optional query. */
    it("should accept well-formed include lines only", () => {
        for (const line of ["@a.md", "@./x.md", "@~ns/r/x.md", "@#project/x.md", "@${root}/x.md", "@parts/*.md", "@x.md?mood=calm", "@repo:ns/r/x.md", "@/abs/path/x.md"]) {
            expect(isIncludeLine(line), line).toBe(true);
        }

        for (const line of ["@a.txt", "@a.md extra", "a.md", "@x.md@^1"]) {
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
