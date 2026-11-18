import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apply, makeTmpDir, read, write, type TestEntry } from "../test/helpers.js";
import { createDocument } from "@sous-io/sous-lib-documents";
import type { ConfigBuilder } from "@sous-io/sous-plugin-api";
import { editor } from "./chain.js";
import { EDITS_KEY } from "./entries.js";
import { resolveOperation } from "./operations.js";

let tmp: { path: string; cleanup(): void };

beforeEach(() => {
    tmp = makeTmpDir();
});

afterEach(() => {
    tmp.cleanup();
});

const AGENT = `---
name: reviewer
model: sonnet # for now
tools:
  - Read
  - Bash
---
# Reviewer

Reviews pull requests. # not a comment
`;

const SETTINGS = `{
    // Editor settings
    "tabSize": 4,
    "files.exclude": {
        "**/.git": true
    }
}
`;

/**
 * Applies the entries to a file holding `text`, checks the result, then applies nothing and
 * checks the file is back to `text` byte for byte.
 */
async function roundTrip(file: string, text: string, entries: TestEntry[], expected: string): Promise<void> {
    write(tmp.path, file, text);

    const first = await apply(tmp.path, entries);

    expect(first.reporter.at("warning")).toEqual([]);
    expect(read(tmp.path, file)).toBe(expected);

    // Applying again changes nothing.
    await apply(tmp.path, entries);
    expect(read(tmp.path, file)).toBe(expected);

    await apply(tmp.path, []);
    expect(read(tmp.path, file)).toBe(text);
}

describe("setCommentBefore", () => {
    /**
     * setCommentBefore should put comment lines above a key, indented like it, and removing the
     * declaration should give the file back byte for byte.
     *
     * model: sonnet   setCommentBefore { path: model, text: "Chosen by the team" }
     * // -> # Chosen by the team
     * //    model: sonnet
     */
    it("should add a comment above a frontmatter key and undo it", async () => {
        await roundTrip(
            ".claude/agents/reviewer.md",
            AGENT,
            [{ entry: { file: ".claude/agents/reviewer.md", setCommentBefore: { path: "model", text: "Chosen by the team\nAsk before changing it" } } }],
            AGENT.replace("model: sonnet", "# Chosen by the team\n# Ask before changing it\nmodel: sonnet"),
        );
    });

    /**
     * Replacing a JSONC comment keeps its indentation and line ending; undo puts the old one back.
     */
    it("should replace a JSONC comment in a CRLF file and undo it", async () => {
        const crlf = SETTINGS.replace(/\n/g, "\r\n");

        await roundTrip(
            ".vscode/settings.json",
            crlf,
            [{ entry: { file: ".vscode/settings.json", setCommentBefore: { path: "tabSize", text: "Four spaces" } } }],
            crlf.replace("// Editor settings", "// Four spaces"),
        );
    });

    /**
     * A list item's comment goes above its dash.
     */
    it("should comment a YAML list item", async () => {
        await roundTrip(
            "ci.yml",
            "steps:\n  - checkout\n  - test\n",
            [{ entry: { file: "ci.yml", setCommentBefore: { path: "steps[1]", text: "The slow one" } } }],
            "steps:\n  - checkout\n  # The slow one\n  - test\n",
        );
    });

    /**
     * Plain JSON has no comments: the edit is skipped with a warning, and the file is left alone.
     */
    it("should skip a plain JSON file with a warning", async () => {
        write(tmp.path, ".claude/settings.json", '{\n  "a": 1\n}\n');

        const { reporter } = await apply(tmp.path, [{ entry: { file: ".claude/settings.json", setCommentBefore: { path: "a", text: "x" } } }]);

        expect(reporter.at("warning").join("\n")).toMatch(/Plain JSON has no comments/);
        expect(read(tmp.path, ".claude/settings.json")).toBe('{\n  "a": 1\n}\n');
    });

    /**
     * It needs a key's path and its words; the root has no comment of its own.
     */
    it("should refuse a missing path or text", () => {
        expect(() => resolveOperation("setCommentBefore", { text: "x" })).toThrow(/needs the 'path'/);
        expect(() => resolveOperation("setCommentBefore", { path: "a" })).toThrow(/needs 'text'/);
        expect(resolveOperation("setCommentBefore", { path: "a", text: "x" }).definition.assertions({ path: "a", text: "x" }, "a")).toEqual([]);
    });
});

describe("setCommentAfter", () => {
    /**
     * setCommentAfter should replace the comment at the end of a key's line, keeping the spacing
     * before it; removing the declaration gives the file back byte for byte.
     *
     * model: sonnet # for now   setCommentAfter { path: model, text: pinned }
     * // -> model: sonnet # pinned
     */
    it("should replace a frontmatter comment after a key and undo it", async () => {
        await roundTrip(
            ".claude/agents/reviewer.md",
            AGENT,
            [{ entry: { file: ".claude/agents/reviewer.md", setCommentAfter: { path: "model", text: "pinned" } } }],
            AGENT.replace("# for now", "# pinned"),
        );
    });

    /**
     * A line with no comment gets one, on the last key of a block and on a list item; the line's
     * trailing spaces, and its CRLF ending, come back on undo.
     */
    it("should add a comment after the last key of a block and after a list item", async () => {
        await roundTrip(
            ".vscode/settings.json",
            SETTINGS.replace('"**/.git": true', '"**/.git": true  '),
            [{ entry: { file: ".vscode/settings.json", setCommentAfter: { path: '"files.exclude"."**/.git"', text: "hidden" } } }],
            SETTINGS.replace('"**/.git": true', '"**/.git": true // hidden'),
        );

        await roundTrip(
            "ci.yml",
            "on: push\r\nsteps:\r\n  - checkout\r\n  - test\r\n",
            [{ entry: { file: "ci.yml", setCommentAfter: { path: "steps[1]", text: "slow" } } }],
            "on: push\r\nsteps:\r\n  - checkout\r\n  - test # slow\r\n",
        );
    });

    /**
     * A comment after a value is one line.
     */
    it("should refuse a comment of several lines", () => {
        expect(() => resolveOperation("setCommentAfter", { path: "a", text: "one\ntwo" })).toThrow(/one line/);
    });

    /**
     * The chain records each comment operation as an entry, like the other operations.
     *
     * editor(config).file("ci.yml").at("on").setCommentAfter("x");
     * // -> { file: "ci.yml", setCommentAfter: { path: "on", text: "x" } }
     */
    it("should be recorded by the chain", () => {
        const config = createDocument({});
        const file = editor(config as unknown as ConfigBuilder).file("ci.yml");

        file.at("on").setCommentAfter("x");
        file.at("on").setCommentBefore("y");

        expect(config.atPath(EDITS_KEY).get()).toEqual([
            { file: "ci.yml", setCommentAfter: { path: "on", text: "x" } },
            { file: "ci.yml", setCommentBefore: { path: "on", text: "y" } },
        ]);
    });
});
