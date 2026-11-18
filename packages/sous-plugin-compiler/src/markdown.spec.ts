/**
 * Where an `@` reference may stand in Markdown. The cases are the rows of spec 17's comparison
 * tables ("Where the Two Differ"), each run against Claude Code 2.1.326: a row Claude Code imports
 * must give the path here, and a row it does not import must give nothing. Two rows where Claude Code
 * imports despite an apparent escape are tested as departures, at the end.
 */

import { describe, expect, it } from "vitest";
import { findImportTokens, frontmatterEnd, scanMarkdown, stripFrontmatter } from "./markdown.js";
import { importPath, isSousIncludeForm } from "./paths.js";

/** The paths Claude Code's rule takes from a text, in order. */
function imports(text: string): string[] {
    const layout = scanMarkdown(text, { claimLine: isSousIncludeForm });

    return findImportTokens(text, layout.runs)
        .map((token) => importPath(token.run))
        .filter((found): found is string => found !== undefined);
}

describe("the position of a reference (spec 17, rows Claude Code imports)", () => {
    it("should find a reference after two or three spaces", () => {
        expect(imports("  @x.md\n")).toEqual(["x.md"]);
        expect(imports("   @x.md\n")).toEqual(["x.md"]);
    });

    /** It continues the paragraph, so it is not a code block. */
    it("should find a tab- or four-space-indented reference that continues a paragraph", () => {
        expect(imports("Intro line.\n\t@x.md\n")).toEqual(["x.md"]);
        expect(imports("Intro line.\n    @x.md\n")).toEqual(["x.md"]);
    });

    it("should find a reference after a list, heading or quote marker", () => {
        expect(imports("- @x.md\n")).toEqual(["x.md"]);
        expect(imports("1. @x.md\n")).toEqual(["x.md"]);
        expect(imports("# @x.md\n")).toEqual(["x.md"]);
        expect(imports("> @x.md\n")).toEqual(["x.md"]);
    });

    it("should find a reference in the middle of a line, or followed by more text", () => {
        expect(imports("See @x.md for details.\n")).toEqual(["x.md"]);
        expect(imports("@x.md is the file to read.\n")).toEqual(["x.md"]);
        expect(imports("@x.md @y.md\n")).toEqual(["x.md", "y.md"]);
    });

    it("should find a reference inside emphasis, link text or a table cell", () => {
        expect(imports("**@x.md**\n")).toEqual(["x.md"]);
        expect(imports("_@x.md_\n")).toEqual(["x.md"]);
        expect(imports("[@x.md](https://example.com)\n")).toEqual(["x.md"]);
        expect(imports("| a | b |\n|---|---|\n| one | @x.md |\n")).toEqual(["x.md"]);
    });

    it("should find a reference after an HTML comment on the same line", () => {
        expect(imports("<!-- note --> @x.md\n")).toEqual(["x.md"]);
    });
});

describe("text that is not a reference in either (spec 17)", () => {
    /** The `@` does not follow whitespace or the start of a text. */
    it("should find nothing when the @ follows a quote, a bracket, a colon or a letter", () => {
        for (const text of ["(@x.md)", "\"@x.md\"", "'@x.md'", "see:@x.md", "text@x.md"]) {
            expect(imports(`${text}\n`), text).toEqual([]);
        }
    });

    /** Claude Code keeps trailing punctuation as part of the path, so the file is not found. */
    it("should keep trailing punctuation in the path", () => {
        for (const mark of [".", ",", ")", ":", ";", "!", "?"]) {
            expect(imports(`See @x.md${mark}\n`), mark).toEqual([`x.md${mark}`]);
        }
    });
});

describe("file types and path forms (spec 17)", () => {
    it("should read the path as Claude Code does", () => {
        expect(imports("@README\n")).toEqual(["README"]);
        expect(imports("@x.txt\n@x.json\n@x.sh\n@X.MD\n")).toEqual(["x.txt", "x.json", "x.sh", "X.MD"]);
        expect(imports("@docs/notes.txt\n")).toEqual(["docs/notes.txt"]);
        expect(imports("@x.md#section\n")).toEqual(["x.md"]);
        expect(imports("@-dash.md\n")).toEqual(["-dash.md"]);
        expect(imports("@my\\ file.md\n")).toEqual(["my file.md"]);
        expect(imports("@my file.md\n")).toEqual(["my"]);
        expect(imports("@~/no-such-file.md\n")).toEqual(["~/no-such-file.md"]);
        expect(imports("@https://example.com/x.md\n")).toEqual(["https://example.com/x.md"]);
    });

    it("should not import a quoted path or a doubled @", () => {
        expect(imports("@\"x.md\"\n@'x.md'\n@@x.md\n")).toEqual([]);
    });

    /** Markdown emphasis splits the path, so Claude Code imports a file that does not exist. */
    it("should split a path at emphasis, as Claude Code does", () => {
        expect(imports("See @a*b*.md here\n")).toEqual(["a"]);
        expect(imports("See @src/__init__.py here\n")).toEqual(["src/"]);
    });

    /** Sous's own forms are claimed whole when they stand alone; they are never Claude Code imports. */
    it("should claim a line holding one of Sous's own forms", () => {
        const text = "@a*b*.md\n@x.md?name=value\n@~ns/recipe/path.md\n@#memories/**/*.md\n@${var}/x.md\n";
        const layout = scanMarkdown(text, { claimLine: isSousIncludeForm });

        expect(layout.claimed.map((line) => line.word)).toEqual(["a*b*.md", "x.md?name=value", "~ns/recipe/path.md", "#memories/**/*.md", "${var}/x.md"]);
        expect(findImportTokens(text, layout.runs)).toEqual([]);
    });

    it("should claim a Sous form on a line that continues a paragraph, but not an indented one", () => {
        const text = "Intro\n@parts/*.md\n\n  @parts/*.md\n";
        const layout = scanMarkdown(text, { claimLine: isSousIncludeForm });

        expect(layout.claimed).toEqual([{ start: 6, end: 17, next: 18, word: "parts/*.md" }]);
    });
});

describe("escapes (spec 17)", () => {
    it("should skip code spans of any backtick count", () => {
        expect(imports("Use `@x.md` here\n")).toEqual([]);
        expect(imports("Use ``@x.md`` here\n")).toEqual([]);
        expect(imports("Use `` a ` @x.md `` here\n")).toEqual([]);
        expect(imports("Use ` @x.md ` here\n")).toEqual([]);
    });

    it("should skip fenced code blocks of backticks or tildes, three or more", () => {
        expect(imports("```\n@x.md\n```\n")).toEqual([]);
        expect(imports("~~~text\n@x.md\n~~~\n")).toEqual([]);
        expect(imports("````\n```\n@x.md\n````\n@y.md\n")).toEqual(["y.md"]);
        expect(imports("```\n~~~\n@x.md\n```\n\n@y.md\n")).toEqual(["y.md"]);
    });

    it("should skip an indented code block", () => {
        expect(imports("Text\n\n    @x.md\n")).toEqual([]);
        expect(imports("    @x.md\n")).toEqual([]);
    });

    /** A list paragraph continues after a blank line, so this is not code. */
    it("should find a four-space-indented reference in a loose list item", () => {
        expect(imports("- item\n\n    @x.md\n")).toEqual(["x.md"]);
    });

    it("should skip a multi-line HTML comment, and an HTML block with no blank lines", () => {
        expect(imports("<!--\n@x.md\n-->\n")).toEqual([]);
        expect(imports("<div>\n@x.md\n</div>\n")).toEqual([]);
        expect(imports("<pre>\n@x.md\n\n@y.md\n</pre>\n")).toEqual([]);
        expect(imports("<div>\n@x.md\n\n@y.md\n")).toEqual(["y.md"]);
    });

    it("should skip an inline HTML comment in a paragraph", () => {
        expect(imports("note <!-- @x.md --> end\n")).toEqual([]);
    });

    it("should skip frontmatter at the top of the file", () => {
        expect(imports("---\nsee: @x.md\n---\n@y.md\n")).toEqual(["y.md"]);
    });

    it("should skip link destinations and image text", () => {
        expect(imports("[a](@x.md) [b]( @y.md) [c][@z.md]\n")).toEqual([]);
        expect(imports("![@x.md](y.png) ![ @x.md ](y.png)\n")).toEqual([]);
    });

    /** `\@x.md` was not imported in any of twelve contexts. */
    it("should not take a reference after a backslash, in any context", () => {
        const contexts = [
            "# \\@x.md",
            "> \\@x.md",
            "| a |\n|---|\n| \\@x.md |",
            "**\\@x.md**",
            "[\\@x.md](https://example.com)",
            "- one\n\n- \\@x.md",
            "- one\n  - \\@x.md",
            "See \\@x.md now",
            "1. \\@x.md",
            "Intro\n    \\@x.md",
            "<!-- c --> \\@x.md",
            "\\@x.md",
        ];

        for (const text of contexts) {
            expect(imports(`${text}\n`), text).toEqual([]);
        }
    });

    it("should skip autolinks and inline tags, and scan the text between tags", () => {
        expect(imports("<https://example.com/@x.md> <me@example.com>\n")).toEqual([]);
        expect(imports("<span>@x.md</span>\n")).toEqual(["x.md"]);
    });
});

/**
 * Claude Code scans the raw text of a tight list item as well as its parts, so in a list item it
 * imports a reference inside a code span with spaces in it, or inside an inline comment. Sous
 * honours both escapes instead (see S10, "Where Sous Departs From Claude Code").
 */
describe("departures from Claude Code", () => {
    it("should not take a reference from a code span or comment inside a list item", () => {
        expect(imports("- see ` @x.md ` here\n")).toEqual([]);
        expect(imports("- note <!-- @x.md --> end\n")).toEqual([]);
    });
});

describe("frontmatter", () => {
    it("should find where the frontmatter ends, and strip it", () => {
        expect(frontmatterEnd("---\ntitle: x\n---\nBody\n")).toBe(17);
        expect(frontmatterEnd("---\r\ntitle: x\r\n---\r\nBody\r\n")).toBe(20);
        expect(frontmatterEnd("Body\n---\n")).toBe(0);
        expect(frontmatterEnd("---\nno end\n")).toBe(0);
        expect(stripFrontmatter("---\na: 1\n...\nBody")).toBe("Body");
    });
});

describe("findImportTokens", () => {
    it("should give the offsets of each reference, from the @ to the end of its run", () => {
        const text = "See @x.md#part and @y.md\n";

        expect(findImportTokens(text, scanMarkdown(text).runs)).toEqual([
            { at: 4, end: 14, run: "x.md#part" },
            { at: 19, end: 24, run: "y.md" },
        ]);
    });
});
