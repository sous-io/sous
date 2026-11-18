import { describe, expect, it } from "vitest";
import { commentStyleForPath, formatForPath } from "./formats.js";
import { HASH_COMMENTS, HTML_COMMENTS, SLASH_COMMENTS } from "./lines.js";

describe("formatForPath()", () => {
    /**
     * formatForPath should choose a format from a path's extension or name.
     *
     * formatForPath(".claude/agents/reviewer.md");   // "markdown"
     */
    it("should choose a format from the path", () => {
        expect(formatForPath(".claude/settings.json")).toBe("json");
        expect(formatForPath("a/b/c.JSON")).toBe("json");
        expect(formatForPath("settings.jsonc")).toBe("jsonc");
        expect(formatForPath(".pre-commit-config.yaml")).toBe("yaml");
        expect(formatForPath(".github/workflows/ci.yml")).toBe("yaml");
        expect(formatForPath(".claude/agents/reviewer.md")).toBe("markdown");
        expect(formatForPath("docs/page.mdx")).toBe("markdown");
        expect(formatForPath("notes.markdown")).toBe("markdown");
        expect(formatForPath("requirements.txt")).toBe("lines");
    });

    /**
     * JSON files that by convention hold comments should be jsonc.
     */
    it("should know the JSON files that hold comments", () => {
        expect(formatForPath("tsconfig.json")).toBe("jsonc");
        expect(formatForPath("packages/a/tsconfig.build.json")).toBe("jsonc");
        expect(formatForPath("jsconfig.json")).toBe("jsonc");
        expect(formatForPath(".devcontainer/devcontainer.json")).toBe("jsonc");
        expect(formatForPath(".eslintrc.json")).toBe("jsonc");
        expect(formatForPath(".vscode/settings.json")).toBe("jsonc");
        expect(formatForPath("C:\\work\\.vscode\\mcp.json")).toBe("jsonc");
        expect(formatForPath(".mcp.json")).toBe("json");
    });

    /**
     * Ignore files, .gitattributes, CODEOWNERS, .env files and version pins should be lines.
     */
    it("should know plain text files by name", () => {
        for (const path of [".gitignore", "docs/.gitignore", ".dockerignore", ".prettierignore", ".gitattributes", ".github/CODEOWNERS", ".env", ".env.local", ".nvmrc", ".tool-versions"]) {
            expect(formatForPath(path), path).toBe("lines");
        }
    });

    /** A file Sous cannot edit, TOML among them, should have no format. */
    it("should give no format for other files", () => {
        expect(formatForPath("config.toml")).toBeUndefined();
        expect(formatForPath("Makefile")).toBeUndefined();
        expect(formatForPath("script.sh")).toBeUndefined();
        expect(formatForPath(".bashrc")).toBeUndefined();
    });
});

describe("commentStyleForPath()", () => {
    /**
     * commentStyleForPath should give HTML comments for markup, // for the C family, and # for
     * everything else.
     *
     * commentStyleForPath("CLAUDE.md");   // { open: "<!--", close: "-->" }
     */
    it("should choose a comment style from the path", () => {
        expect(commentStyleForPath("CLAUDE.md")).toBe(HTML_COMMENTS);
        expect(commentStyleForPath("index.html")).toBe(HTML_COMMENTS);
        expect(commentStyleForPath("src/index.ts")).toBe(SLASH_COMMENTS);
        expect(commentStyleForPath(".vscode/settings.jsonc")).toBe(SLASH_COMMENTS);
        expect(commentStyleForPath(".gitignore")).toBe(HASH_COMMENTS);
        expect(commentStyleForPath("config.toml")).toBe(HASH_COMMENTS);
        expect(commentStyleForPath("Makefile")).toBe(HASH_COMMENTS);
    });
});
