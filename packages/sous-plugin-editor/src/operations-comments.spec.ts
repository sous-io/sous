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

describe("removeComment", () => {
    /**
     * removeComment with neither switch should remove the comments before and after a key; removing
     * the declaration puts both back byte for byte.
     *
     * # The model\nmodel: sonnet # for now   removeComment { path: model }   -> model: sonnet
     */
    it("should remove both comments of a key and undo it", async () => {
        const text = AGENT.replace("model: sonnet", "#   The model, oddly spaced\nmodel: sonnet");

        await roundTrip(
            ".claude/agents/reviewer.md",
            text,
            [{ entry: { file: ".claude/agents/reviewer.md", removeComment: { path: "model" } } }],
            AGENT.replace("model: sonnet # for now", "model: sonnet"),
        );
    });

    /**
     * `before: true` or `after: true` removes only that one; a multi-line JSONC comment goes whole.
     */
    it("should remove only the comment named, in a CRLF JSONC file", async () => {
        const crlf = SETTINGS.replace("    // Editor settings\n", "    // Editor\n    // settings\n").replace(/\n/g, "\r\n");

        await roundTrip(
            ".vscode/settings.json",
            crlf,
            [{ entry: { file: ".vscode/settings.json", removeComment: { path: "tabSize", before: true } } }],
            crlf.replace("    // Editor\r\n    // settings\r\n", ""),
        );

        await roundTrip(
            ".claude/agents/reviewer.md",
            AGENT,
            [{ entry: { file: ".claude/agents/reviewer.md", removeComment: { path: "model", after: true } } }],
            AGENT.replace(" # for now", ""),
        );
    });

    /**
     * A key with no comment is left alone, and nothing is recorded to undo.
     */
    it("should leave a key with no comment as it is", async () => {
        write(tmp.path, "ci.yml", "a: 1\n");

        const { result } = await apply(tmp.path, [{ entry: { file: "ci.yml", removeComment: { path: "a" } } }]);

        expect(result.files[0]!.action).toBe("unchanged");
        expect(() => resolveOperation("removeComment", { path: "a", before: false, after: false })).toThrow(/removes nothing/);
        expect(() => resolveOperation("removeComment", { path: "a", before: "yes" })).toThrow(/true or false/);
    });
});

const STREAM = `# Web, as three documents
---
kind: Service
metadata:
  name: web
---
kind: Deployment
spec:
  replicas: 1 # one for now
---
kind: ConfigMap
data:
  mode: loose
`;

describe("selectDocument (document: <index>)", () => {
    /**
     * An operation with `document` acts on that document of a YAML file holding several; every
     * other byte stays, and removing the declaration gives the file back byte for byte.
     *
     * set { document: 1, path: spec.replicas, value: 3 }   // only "replicas: 1" changes
     */
    it("should edit the first, middle and last document and undo it", async () => {
        await roundTrip(
            "deploy/web.yaml",
            STREAM,
            [{ entry: { file: "deploy/web.yaml", set: { document: 0, path: "metadata.name", value: "api" } } }],
            STREAM.replace("name: web", "name: api"),
        );
        await roundTrip(
            "deploy/web.yaml",
            STREAM,
            [{ entry: { file: "deploy/web.yaml", set: { document: 1, path: "spec.replicas", value: 3 } } }],
            STREAM.replace("replicas: 1", "replicas: 3"),
        );
        await roundTrip(
            "deploy/web.yaml",
            STREAM,
            [{ entry: { file: "deploy/web.yaml", set: { document: 2, path: "data.tags", value: ["a"] } } }],
            `${STREAM}  tags:\n    - a\n`,
        );
    });

    /**
     * Several documents in one entry's `operations` list, and comments in a document, all undone together.
     */
    it("should edit values and comments in several documents of one file", async () => {
        await roundTrip(
            "deploy/web.yaml",
            STREAM,
            [{
                entry: {
                    file: "deploy/web.yaml",
                    operations: [
                        { setCommentAfter: { document: 1, path: "spec.replicas", text: "three in production" } },
                        { set: { document: 1, path: "spec.replicas", value: 3 } },
                        { setCommentBefore: { document: 2, path: "data.mode", text: "Set by Sous" } },
                    ],
                },
            }],
            STREAM.replace("replicas: 1 # one for now", "replicas: 3 # three in production").replace("  mode: loose", "  # Set by Sous\n  mode: loose"),
        );
    });

    /**
     * A file with one document is document 0; an index past the last document, and a file that is
     * not YAML, skip the edit with a warning and leave the file alone.
     */
    it("should treat a single document as document 0 and skip a missing one", async () => {
        await roundTrip("a.yaml", "a: 1\n", [{ entry: { file: "a.yaml", set: { document: 0, path: "a", value: 2 } } }], "a: 2\n");

        write(tmp.path, "deploy/web.yaml", STREAM);
        write(tmp.path, "b.jsonc", "{}\n");

        const { reporter } = await apply(tmp.path, [
            { entry: { file: "deploy/web.yaml", set: { document: 3, path: "a", value: 1 } } },
            { entry: { file: "b.jsonc", set: { document: 0, path: "a", value: 1 } } },
        ]);
        const warnings = reporter.at("warning").join("\n");

        expect(warnings).toMatch(/holds 3 documents, so it has no document 3/);
        expect(warnings).toMatch(/Only a YAML file holds several documents/);
        expect(read(tmp.path, "deploy/web.yaml")).toBe(STREAM);
        expect(read(tmp.path, "b.jsonc")).toBe("{}\n");
    });

    /**
     * Without `document`, a file holding several documents cannot be parsed as one: it is skipped.
     */
    it("should skip an operation without document on a file holding several", async () => {
        write(tmp.path, "deploy/web.yaml", STREAM);

        const { reporter } = await apply(tmp.path, [{ entry: { file: "deploy/web.yaml", set: { path: "kind", value: "x" } } }]);

        expect(reporter.at("warning").join("\n")).toMatch(/multiple documents/);
        expect(read(tmp.path, "deploy/web.yaml")).toBe(STREAM);
    });

    /**
     * `document` is a whole number from 0, on an operation that acts inside a document; with it,
     * no automatic assertion is implied.
     */
    it("should check the document parameter and imply no assertion", () => {
        expect(() => resolveOperation("set", { document: -1, path: "a", value: 1 })).toThrow(/whole number from 0/);
        expect(() => resolveOperation("set", { document: "1", path: "a", value: 1 })).toThrow(/whole number from 0/);
        expect(() => resolveOperation("ensureFileExists", { document: 0 })).toThrow(/whole file/);
        expect(() => resolveOperation("ensureLine", { document: 0, line: "x" })).toThrow(/whole file's text/);

        const step = resolveOperation("set", { document: 1, path: "a", value: 1 });

        expect(step.definition.assertions(step.params, step.path)).toEqual([]);
    });

    /**
     * The chain's `selectDocument(index)` writes `document` on every operation recorded through it.
     *
     * editor(config).file("web.yaml").selectDocument(1).at("spec.replicas").set(3);
     * // -> { file: "web.yaml", set: { path: "spec.replicas", value: 3, document: 1 } }
     */
    it("should be recorded by the chain's selectDocument", () => {
        const config = createDocument({});
        const file = editor(config as unknown as ConfigBuilder).file("web.yaml");

        file.selectDocument(1).at("spec.replicas").set(3);
        file.selectDocument(2).sortKeys();
        file.selectDocument(0).at("kind").setCommentAfter("x");
        file.at("kind").set("Service");

        expect(config.atPath(EDITS_KEY).get()).toEqual([
            { file: "web.yaml", set: { path: "spec.replicas", value: 3, document: 1 } },
            { file: "web.yaml", sortKeys: { document: 2 } },
            { file: "web.yaml", setCommentAfter: { path: "kind", text: "x", document: 0 } },
            { file: "web.yaml", set: { path: "kind", value: "Service" } },
        ]);
        expect(() => file.selectDocument(-1)).toThrow(/whole number from 0/);
    });
});
