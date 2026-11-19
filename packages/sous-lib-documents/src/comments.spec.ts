import { describe, expect, it } from "vitest";
import { CommentError, commentSource, readComment, removeComment, restoreCommentSource, setComment } from "./comments.js";
import { parseDocument } from "./text-document.js";

const YAML = `# The model the reviewer runs on
model: opus # the newest one
tools:
  - Read
  # Only for the shell
  - Bash # dangerous
effort: high
`;

const JSONC = `{
    // The model
    "model": "opus", // the newest one
    "tools": [
        "Read",
        /* Only for the shell */
        "Bash"
    ],
    "effort": "high"
}
`;

describe("readComment()", () => {
    /**
     * readComment should read the comment lines directly above a key or list item ("before") and
     * the comment ending its line ("after"), markers taken off, in YAML and JSONC.
     *
     * readComment("# The model\nmodel: opus # newest\n", "yaml", "model", "after");   // -> "newest"
     */
    it("should read the comments before and after a key and a list item", () => {
        expect(readComment(YAML, "yaml", "model", "before")).toBe("The model the reviewer runs on");
        expect(readComment(YAML, "yaml", "model", "after")).toBe("the newest one");
        expect(readComment(YAML, "yaml", "tools[1]", "before")).toBe("Only for the shell");
        expect(readComment(YAML, "yaml", "tools[1]", "after")).toBe("dangerous");
        expect(readComment(JSONC, "jsonc", "model", "before")).toBe("The model");
        expect(readComment(JSONC, "jsonc", "model", "after")).toBe("the newest one");
        expect(readComment(JSONC, "jsonc", "tools[1]", "before")).toBe("Only for the shell");
    });

    /**
     * A key with no comment reads `undefined`, and a `#` inside a quoted string is not a comment.
     *
     * readComment('a: "x # y"\n', "yaml", "a", "after");   // -> undefined
     */
    it("should read undefined for a key with no comment, ignoring # inside quotes", () => {
        expect(readComment(YAML, "yaml", "effort", "before")).toBeUndefined();
        expect(readComment(YAML, "yaml", "effort", "after")).toBeUndefined();
        expect(readComment('a: "x # y"\n', "yaml", "a", "after")).toBeUndefined();
        expect(readComment(JSONC, "jsonc", "effort", "after")).toBeUndefined();
    });

    /**
     * A comment above at another indentation, or with a blank line between, belongs to something else.
     *
     * "a:\n  b: 1\n  # inner\nc: 2\n"   // c has no comment before it
     */
    it("should not take a comment at another indentation or across a blank line", () => {
        expect(readComment("a:\n  b: 1\n  # inner\nc: 2\n", "yaml", "c", "before")).toBeUndefined();
        expect(readComment("# far\n\nc: 2\n", "yaml", "c", "before")).toBeUndefined();
    });

    /**
     * Several comment lines read as one comment, joined with `\n`; a JSONC block's ` * ` goes.
     */
    it("should read a multi-line comment", () => {
        expect(readComment("# one\n# two\na: 1\n", "yaml", "a", "before")).toBe("one\ntwo");
        expect(readComment("{\n  /*\n   * one\n   * two\n   */\n  \"a\": 1\n}\n", "jsonc", "a", "before")).toBe("one\ntwo");
    });

    /**
     * Plain JSON has no comments: every comment function refuses it with a CommentError.
     */
    it("should refuse plain JSON", () => {
        expect(() => readComment('{"a": 1}', "json", "a", "before")).toThrow(CommentError);
        expect(() => setComment('{"a": 1}', "json", "a", "before", "x")).toThrow(/Plain JSON has no comments/);
        expect(() => removeComment('{"a": 1}', "json", "a", "after")).toThrow(CommentError);
    });

    /**
     * A missing path, the root, and a value sharing its line with others are refused.
     */
    it("should refuse a missing path, the root and a value that shares its line", () => {
        expect(() => readComment(YAML, "yaml", "nope", "before")).toThrow(/no value at nope/);
        expect(() => readComment(YAML, "yaml", "", "before")).toThrow(/root/);
        expect(() => readComment("a: [1, 2]\n", "yaml", "a[0]", "after")).toThrow(/flow/);
        expect(() => readComment('{"a": 1, "b": 2}', "jsonc", "b", "after")).toThrow(/shares its line/);
    });
});

describe("setComment()", () => {
    /**
     * setComment should add a comment before a key with its indentation, and after it on its line,
     * changing nothing else.
     *
     * setComment("a:\n  b: 1\n", "yaml", "a.b", "before", "note");   // -> "a:\n  # note\n  b: 1\n"
     */
    it("should add a comment before and after a YAML key", () => {
        expect(setComment("a:\n  b: 1\n", "yaml", "a.b", "before", "note")).toBe("a:\n  # note\n  b: 1\n");
        expect(setComment("a:\n  b: 1\n", "yaml", "a.b", "after", "note")).toBe("a:\n  b: 1 # note\n");
        expect(setComment("a:\n  b: 1\n", "yaml", "a", "after", "note")).toBe("a: # note\n  b: 1\n");
    });

    /**
     * Replacing keeps the spacing before an after-comment and the indentation of a before-comment.
     */
    it("should replace an existing comment, before and after", () => {
        const before = setComment(YAML, "yaml", "model", "before", "Chosen by the team");
        const after = setComment(YAML, "yaml", "model", "after", "pinned");

        expect(before).toBe(YAML.replace("# The model the reviewer runs on", "# Chosen by the team"));
        expect(after).toBe(YAML.replace("# the newest one", "# pinned"));
        expect(setComment(JSONC, "jsonc", "model", "after", "pinned")).toBe(JSONC.replace("// the newest one", "// pinned"));
        expect(setComment(JSONC, "jsonc", "tools[1]", "before", "Shell")).toBe(JSONC.replace("/* Only for the shell */", "/* Shell */"));
    });

    /**
     * A comment before may have several lines; one after may not.
     */
    it("should write a multi-line comment before, and refuse one after", () => {
        expect(setComment("a: 1\n", "yaml", "a", "before", "one\ntwo")).toBe("# one\n# two\na: 1\n");
        expect(setComment("{\n    \"a\": 1\n}\n", "jsonc", "a", "before", "one\ntwo")).toBe("{\n    // one\n    // two\n    \"a\": 1\n}\n");
        expect(() => setComment("a: 1\n", "yaml", "a", "after", "one\ntwo")).toThrow(/one line/);
    });

    /**
     * A CRLF file gets CRLF comment lines, and every other byte stays.
     */
    it("should keep the file's CRLF line endings", () => {
        const text = "a: 1\r\nb: 2\r\n";

        expect(setComment(text, "yaml", "b", "before", "one\ntwo")).toBe("a: 1\r\n# one\r\n# two\r\nb: 2\r\n");
        expect(setComment(text, "yaml", "a", "after", "x")).toBe("a: 1 # x\r\nb: 2\r\n");
        expect(readComment("# x\r\na: 1 # y\r\n", "yaml", "a", "before")).toBe("x");
        expect(readComment("# x\r\na: 1 # y\r\n", "yaml", "a", "after")).toBe("y");
        expect(setComment("{\r\n  \"a\": 1\r\n}\r\n", "jsonc", "a", "after", "x")).toBe("{\r\n  \"a\": 1 // x\r\n}\r\n");
    });

    /**
     * The last key of a block, and the last item of a JSONC array (no comma), take comments too.
     */
    it("should comment the last key in a block and the last item of a list", () => {
        expect(setComment("a:\n  b: 1\n  c: 2\nd: 3\n", "yaml", "a.c", "after", "last")).toBe("a:\n  b: 1\n  c: 2 # last\nd: 3\n");
        expect(setComment(JSONC, "jsonc", "tools[1]", "after", "last")).toBe(JSONC.replace('"Bash"\n', '"Bash" // last\n'));
        expect(setComment(JSONC, "jsonc", "effort", "before", "Effort")).toBe(JSONC.replace('    "effort"', '    // Effort\n    "effort"'));
    });

    /**
     * A list item's comment goes above its dash; the first key of an item map shares the dash's line.
     */
    it("should comment a YAML list item", () => {
        expect(setComment("- a\n- b\n", "yaml", "[1]", "before", "second")).toBe("- a\n# second\n- b\n");
        expect(setComment("x:\n  - name: a\n", "yaml", "x[0].name", "after", "first")).toBe("x:\n  - name: a # first\n");
        expect(readComment("x:\n  - name: a # first\n", "yaml", "x[0]", "after")).toBe("first");
    });

    /**
     * A comment that would change a value (inside a multi-line string) is refused.
     */
    it("should refuse a comment that would change a value", () => {
        expect(() => setComment("a: one\n  two\n", "yaml", "a", "after", "x")).toThrow(CommentError);
    });
});

describe("removeComment()", () => {
    /**
     * removeComment should take away the comment's lines, or the comment and the spaces before it.
     *
     * removeComment("a: 1 # x\n", "yaml", "a", "after");   // -> "a: 1\n"
     */
    it("should remove a comment before and after, and leave a node with none as it is", () => {
        expect(removeComment(YAML, "yaml", "model", "before")).toBe(YAML.replace("# The model the reviewer runs on\n", ""));
        expect(removeComment(YAML, "yaml", "model", "after")).toBe(YAML.replace(" # the newest one", ""));
        expect(removeComment(YAML, "yaml", "tools[1]", "before")).toBe(YAML.replace("  # Only for the shell\n", ""));
        expect(removeComment(JSONC, "jsonc", "model", "after")).toBe(JSONC.replace(" // the newest one", ""));
        expect(removeComment(YAML, "yaml", "effort", "before")).toBe(YAML);
        expect(removeComment(YAML, "yaml", "effort", "after")).toBe(YAML);
        expect(removeComment("# one\r\n# two\r\na: 1\r\n", "yaml", "a", "before")).toBe("a: 1\r\n");
    });
});

describe("commentSource() and restoreCommentSource()", () => {
    /**
     * The source of a comment, put back, gives the text byte for byte, odd spacing included.
     *
     * commentSource("a: 1   #x  \n", "yaml", "a", "after");   // -> "   #x  "
     */
    it("should put a comment back byte for byte", () => {
        const text = "#odd\n#  spacing\na: 1   #x  \nb: 2  \n";

        for (const [path, place] of [["a", "before"], ["a", "after"], ["b", "after"]] as const) {
            const source = commentSource(text, "yaml", path, place);
            const changed = setComment(text, "yaml", path, place, "new");

            expect(restoreCommentSource(changed, "yaml", path, place, source)).toBe(text);
        }

        expect(commentSource(text, "yaml", "a", "after")).toBe("   #x  ");
    });
});

describe("TextDocument comments", () => {
    /**
     * A Markdown document reads and writes the comments of its frontmatter; the body is untouched.
     *
     * "---\nmodel: opus\n---\n# Body\n"  setComment(model, after, "x")  -> "---\nmodel: opus # x\n---\n# Body\n"
     */
    it("should edit the comments of a Markdown file's frontmatter", () => {
        const doc = parseDocument("---\nmodel: opus\n---\n# Body # not a comment\n", "markdown");

        doc.setComment("model", "after", "x");
        doc.setComment("model", "before", "The model");

        expect(doc.toString()).toBe("---\n# The model\nmodel: opus # x\n---\n# Body # not a comment\n");
        expect(doc.comment("model", "after")).toBe("x");

        doc.removeComment("model", "before");
        doc.removeComment("model", "after");

        expect(doc.toString()).toBe("---\nmodel: opus\n---\n# Body # not a comment\n");
    });

    /**
     * Comment edits and value edits mix: each keeps the other's bytes.
     */
    it("should keep a comment when a value on its line changes", () => {
        const doc = parseDocument(JSONC, "jsonc");

        doc.setComment("effort", "after", "how hard");
        doc.atPath("effort").set("low");

        expect(doc.toString()).toBe(JSONC.replace('"effort": "high"', '"effort": "low" // how hard'));
        expect(() => parseDocument("{}", "json").comment("a", "after")).toThrow(CommentError);
    });
});
