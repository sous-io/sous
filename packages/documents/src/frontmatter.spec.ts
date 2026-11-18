import { describe, expect, it } from "vitest";
import { joinFrontmatter, splitFrontmatter } from "./frontmatter.js";
import { parseDocument } from "./text-document.js";

/** An agent file: frontmatter with a comment, and a body that must never change. */
const AGENT = `---
name: reviewer   # shown in the picker
model: sonnet
tools: [Read, Grep]
---

# Reviewer

---
A horizontal rule above, and a fake key below:
model: haiku
`;

describe("splitFrontmatter()", () => {
    /**
     * splitFrontmatter should cut a text at its frontmatter's closing line, keeping both marker
     * lines in `head`, so head + body is the text.
     *
     * splitFrontmatter("---\ntitle: Hi\n---\n# Hi\n").yaml;   // "title: Hi\n"
     */
    it("should cut a Markdown text into frontmatter and body", () => {
        const parts = splitFrontmatter(AGENT);

        expect(parts.open).toBe("---\n");
        expect(parts.yaml).toBe("name: reviewer   # shown in the picker\nmodel: sonnet\ntools: [Read, Grep]\n");
        expect(parts.close).toBe("---\n");
        expect(parts.head + parts.body).toBe(AGENT);
        expect(parts.body.startsWith("\n# Reviewer")).toBe(true);
    });

    /**
     * Only a first line `---` opens frontmatter, and it needs a closing `---` or `...` line;
     * otherwise the whole text is the body.
     */
    it("should find no frontmatter unless both markers are there", () => {
        expect(splitFrontmatter("# Title\n---\na: 1\n---\n")).toEqual({ head: "", open: undefined, yaml: undefined, close: undefined, body: "# Title\n---\na: 1\n---\n" });
        expect(splitFrontmatter("---\na: 1\n").yaml).toBeUndefined();
        expect(splitFrontmatter("---\r\na: 1\r\n...\r\nbody").yaml).toBe("a: 1\r\n");
        expect(splitFrontmatter("---\n---\n").yaml).toBe("");
        expect(splitFrontmatter("---\na: 1\n---").close).toBe("---");
        expect(splitFrontmatter("---\na: 1\n----\n").yaml).toBeUndefined();
    });
});

describe("joinFrontmatter()", () => {
    /**
     * joinFrontmatter should keep the markers there were, add `---` lines in the text's line
     * ending when there were none, and drop the block when the YAML is empty.
     *
     * joinFrontmatter(splitFrontmatter("# Hi\n"), "title: Hi\n");   // "---\ntitle: Hi\n---\n# Hi\n"
     */
    it("should put the text back together", () => {
        expect(joinFrontmatter(splitFrontmatter("# Hi\n"), "title: Hi\n")).toBe("---\ntitle: Hi\n---\n# Hi\n");
        expect(joinFrontmatter(splitFrontmatter("# Hi\r\n"), "title: Hi")).toBe("---\r\ntitle: Hi\r\n---\r\n# Hi\r\n");
        expect(joinFrontmatter(splitFrontmatter("---\na: 1\n...\nbody"), "a: 2\n")).toBe("---\na: 2\n...\nbody");
        expect(joinFrontmatter(splitFrontmatter("---\na: 1\n---\nbody"), "")).toBe("body");
    });
});

describe("TextDocument (Markdown frontmatter)", () => {
    /**
     * A `markdown` document should be the frontmatter's value; untouched, it prints back byte
     * for byte.
     */
    it("should read the frontmatter as the document", () => {
        const doc = parseDocument(AGENT, "markdown");

        expect(doc.value()).toEqual({ name: "reviewer", model: "sonnet", tools: ["Read", "Grep"] });
        expect(doc.toString()).toBe(AGENT);
        expect(parseDocument("# No frontmatter\n", "markdown").value()).toEqual({});
    });

    /**
     * Edits should change only the frontmatter's own lines, surgically, and never the body,
     * even where the body looks like YAML.
     *
     * doc.atPath("model").set("opus");   // model: sonnet -> model: opus; the body's "model: haiku" stays
     */
    it("should edit only the frontmatter", () => {
        const doc = parseDocument(AGENT, "markdown");

        doc.atPath("model").set("opus");
        doc.atPath("tools").append("Edit");
        doc.atPath("effort").set("high");

        expect(doc.toString()).toBe(AGENT
            .replace("model: sonnet\n", "model: opus\n")
            .replace("[Read, Grep]\n", "[Read, Grep, Edit]\neffort: high\n"));
        expect(doc.reprinted()).toBe(false);
    });

    /**
     * A file with no frontmatter should get one when a value is set, the body kept byte for byte;
     * removing every key again should remove the block.
     */
    it("should add frontmatter, and remove it when emptied", () => {
        const body = "# Notes\r\n\r\nText.\r\n";
        const doc = parseDocument(body, "markdown");

        doc.atPath("title").set("Notes");
        expect(doc.toString()).toBe(`---\r\ntitle: Notes\r\n---\r\n${body}`);

        doc.atPath("title").delete();
        expect(doc.toString()).toBe(body);
    });

    /** Frontmatter that is not valid YAML should be rejected, naming the problem. */
    it("should reject invalid frontmatter", () => {
        expect(() => parseDocument("---\na: [1\n---\nbody\n", "markdown")).toThrow("The YAML text is not valid");
    });
});
