import { describe, expect, it } from "vitest";
import { createDocument } from "./value-document.js";
import { parseDocument, type TextDocument } from "./text-document.js";
import type { DocumentFormat } from "./types.js";

/** Edits a text and returns the result, checking it reads back as the document's value. */
function edit(text: string, format: DocumentFormat, change: (doc: TextDocument) => void): string {
    const doc = parseDocument(text, format);

    change(doc);

    const result = doc.toString();

    expect(doc.reprinted()).toBe(false);
    expect(JSON.stringify(parseDocument(result, format).value())).toBe(JSON.stringify(doc.value()));

    return result;
}

/** Removes the entry at a path and puts it back from its recorded source, in a new document each time (as two builds do). */
function deleteAndRestore(text: string, format: DocumentFormat, path: string): { removed: string; restored: string } {
    const doc = parseDocument(text, format);
    const node = doc.atPath(path);
    const value = node.get();
    const entry = node.entrySource()!;

    node.delete();

    const removed = doc.toString();
    const restored = edit(removed, format, (again) => again.atPath(path).restoreEntrySource(value, entry));

    return { removed, restored };
}

const JSONC = `{
    // The name.
    // Two lines about it.
    "name": "demo", // the name
    "mode": "loose",

    /* The options. */
    "options": {
        // about x
        "x": 1,
        "y": 2
    },
    // the last
    "last": true
}
`;

const YAML = `# The name.
# Two lines about it.
name: demo # the name
mode: loose

# The options.
options:
  # about x
  x: 1
  y: 2
# the last
last: true
`;

describe("removing an entry", () => {
    /**
     * A key removed takes its comment lines above it (the "before" comment: the comment lines
     * directly above at its indentation) and the comment ending its line; the blank line above
     * the next group stays.
     *
     * "# The name.\n# Two lines about it.\nname: demo # the name\nmode: loose\n..."  delete name
     * // -> "mode: loose\n..."
     */
    it("should take a key's comment lines with it and leave blank lines", () => {
        expect(edit(YAML, "yaml", (doc) => doc.atPath("name").delete())).toBe(YAML.replace("# The name.\n# Two lines about it.\nname: demo # the name\n", ""));
        expect(edit(JSONC, "jsonc", (doc) => doc.atPath("name").delete())).toBe(JSONC.replace('    // The name.\n    // Two lines about it.\n    "name": "demo", // the name\n', ""));
        expect(edit(YAML, "yaml", (doc) => doc.atPath("options").delete())).toBe(YAML.replace("# The options.\noptions:\n  # about x\n  x: 1\n  y: 2\n", ""));
        expect(edit(JSONC, "jsonc", (doc) => doc.atPath("last").delete())).toBe(JSONC.replace('    },\n    // the last\n    "last": true\n', "    }\n"));
    });
});

describe("restoreEntrySource()", () => {
    for (const [format, text] of [["yaml", YAML], ["jsonc", JSONC]] as const) {
        /**
         * A key removed and put back from its `entrySource()` comes back in its old place, with
         * its comment lines and the comment on its line, byte for byte: the first key, the last,
         * one between two commented keys, one after a blank line, and one in a nested object.
         *
         * delete mode; restoreEntrySource("loose", { source: "mode: loose\n", index: 1, after: "name" })
         * // -> the original text
         */
        it(`should put a key back where it was with its comments in ${format}`, () => {
            for (const path of ["name", "mode", "options", "last", "options.x", "options.y"]) {
                const { removed, restored } = deleteAndRestore(text, format, path);

                expect(removed, path).not.toBe(text);
                expect(restored, path).toBe(text);
            }
        });
    }

    /**
     * A key alone between two blank lines leaves both when removed, and goes back between them:
     * the recorded gap says how many lines lay between it and the key before.
     *
     * "a: 1\n\nb: 2\n\nc: 3\n"  delete b -> "a: 1\n\n\nc: 3\n"; restore -> the original
     */
    it("should put a key back between the same blank lines", () => {
        for (const [format, text] of [
            ["yaml", "a: 1\n\n# about b\nb: 2\n\nc: 3\n"],
            ["yaml", "\n# about a\na: 1\n\nb: 2\n"],
            ["jsonc", '{\n  "a": 1,\n\n  // about b\n  "b": 2,\n\n  "c": 3\n}\n'],
            ["jsonc", '{\n\n  "a": 1,\n\n  "b": 2\n}\n'],
        ] as const) {
            const doc = parseDocument(text, format);

            expect(deleteAndRestore(text, format, doc.root().keys()[1]!).restored).toBe(text);
            expect(deleteAndRestore(text, format, doc.root().keys()[0]!).restored).toBe(text);
        }

        expect(parseDocument("a: 1\n\nb: 2\n\nc: 3\n", "yaml").atPath("b").entrySource()).toEqual({ source: "b: 2\n", index: 1, after: "a", gap: 1 });
    });

    /**
     * A list item comes back at its index with its comment lines, and Windows line endings are kept.
     *
     * "list:\r\n  # bee\r\n  - b\r\n  - a\r\n"  delete list[0], restore -> the original
     */
    it("should put back a list item, and keep CRLF line endings", () => {
        const yaml = "list:\r\n  # bee\r\n  - b\r\n  # ay\r\n  - a\r\nnext: 1\r\n";
        const jsonc = '{\r\n  "list": [\r\n    // bee\r\n    "b",\r\n    // ay\r\n    "a"\r\n  ],\r\n  // about next\r\n  "next": 1\r\n}\r\n';

        for (const path of ["list[0]", "list[1]", "next"]) {
            expect(deleteAndRestore(yaml, "yaml", path).restored, path).toBe(yaml);
            expect(deleteAndRestore(jsonc, "jsonc", path).restored, path).toBe(jsonc);
        }
    });

    /**
     * When the key that was before it is gone, a key goes back at its index; when the key is
     * there again, it is only set.
     *
     * restoreEntrySource(2, { source: "b: 2\n", index: 1, after: "gone" }) on "a: 1\nc: 3\n" -> "a: 1\nb: 2\nc: 3\n"
     */
    it("should fall back to the index, and only set a key that is back", () => {
        expect(edit("a: 1\nc: 3\n", "yaml", (doc) => doc.atPath("b").restoreEntrySource(2, { source: "b: 2\n", index: 1, after: "gone" }))).toBe("a: 1\nb: 2\nc: 3\n");
        expect(edit("a: 1\nb: 9\n", "yaml", (doc) => doc.atPath("b").restoreEntrySource(2, { source: "b: 2\n", index: 1, after: "a" }))).toBe("a: 1\nb: 2\n");
        // A source that no longer holds the value: new text, in the same place.
        expect(edit("a: 1\nc: 3\n", "yaml", (doc) => doc.atPath("b").restoreEntrySource(5, { source: "b: 2 # two\n", index: 1, after: "a" }))).toBe("a: 1\nb: 5\nc: 3\n");
    });

    /**
     * A Markdown file's frontmatter is YAML: a key goes back into it in its place.
     *
     * "---\n# The model\nmodel: opus\ntools: [Read]\n---\n# Body\n"  delete model, restore -> the original
     */
    it("should put a key back into Markdown frontmatter", () => {
        const text = "---\nname: reviewer\n# The model\nmodel: opus\ntools: [Read]\n---\n# Body\n";

        expect(deleteAndRestore(text, "markdown", "model")).toEqual({ removed: "---\nname: reviewer\ntools: [Read]\n---\n# Body\n", restored: text });
    });
});

describe("insertKey()", () => {
    /**
     * A key is inserted before or after another, or at an index, without rewriting any other
     * key: before a key it goes above that key's comment lines.
     *
     * "a: 1\n# about b\nb: 2\n"  insertKey("z", 0, { before: "b" }) -> "a: 1\nz: 0\n# about b\nb: 2\n"
     */
    it("should insert a key at a position in YAML and JSONC", () => {
        const yaml = "a: 1\n# about b\nb: 2\n";

        expect(edit(yaml, "yaml", (doc) => doc.root().insertKey("z", 0, { before: "b" }))).toBe("a: 1\nz: 0\n# about b\nb: 2\n");
        expect(edit(yaml, "yaml", (doc) => doc.root().insertKey("z", 0, { after: "a" }))).toBe("a: 1\nz: 0\n# about b\nb: 2\n");
        expect(edit(yaml, "yaml", (doc) => doc.root().insertKey("z", 0, { index: 0 }))).toBe("z: 0\na: 1\n# about b\nb: 2\n");
        expect(edit(yaml, "yaml", (doc) => doc.root().insertKey("z", [1], { index: 9 }))).toBe("a: 1\n# about b\nb: 2\nz:\n  - 1\n");

        const jsonc = '{\n  "a": 1,\n  // about b\n  "b": 2\n}\n';

        expect(edit(jsonc, "jsonc", (doc) => doc.root().insertKey("z", 0, { before: "b" }))).toBe('{\n  "a": 1,\n  "z": 0,\n  // about b\n  "b": 2\n}\n');
        expect(edit(jsonc, "jsonc", (doc) => doc.root().insertKey("z", 0, { index: 2 }))).toBe('{\n  "a": 1,\n  // about b\n  "b": 2,\n  "z": 0\n}\n');
        expect(edit('{ "a": 1, "b": 2 }\n', "jsonc", (doc) => doc.root().insertKey("z", 0, { after: "a" }))).toBe('{ "a": 1, "z": 0, "b": 2 }\n');
        expect(Object.keys(parseDocument(jsonc, "jsonc").value() as object)).toEqual(["a", "b"]);
    });

    /**
     * A source written under another key is written with the new key, moved to the new
     * object's indentation, comments included.
     *
     * insertKey("y", 1, { index: 0 }, "  # about x\n  x: 1 # one\n") into "other:\n    k: 0\n"
     * // -> "other:\n    # about x\n    y: 1 # one\n    k: 0\n"
     */
    it("should write a source under the new key at the new indentation", () => {
        expect(edit("other:\n    k: 0\n", "yaml", (doc) => doc.atPath("other").insertKey("y", 1, { index: 0 }, "  # about x\n  x: 1 # one\n")))
            .toBe("other:\n    # about x\n    y: 1 # one\n    k: 0\n");
        expect(edit('{\n    "other": {\n        "k": 0\n    }\n}\n', "jsonc", (doc) => doc.atPath("other").insertKey("y", 1, { index: 1 }, '  // about x\n  "x": 1, // one\n')))
            .toBe('{\n    "other": {\n        "k": 0,\n        // about x\n        "y": 1 // one\n    }\n}\n');
    });

    /**
     * A key that is already there, a missing anchor, and a value that is not an object are errors.
     */
    it("should refuse an existing key, a missing anchor and a non-object", () => {
        const doc = parseDocument("a: 1\nl: []\n", "yaml");

        expect(() => doc.root().insertKey("a", 2, { index: 0 })).toThrow(/already has the key "a"/);
        expect(() => doc.root().insertKey("z", 2, { before: "nope" })).toThrow(/no key "nope"/);
        expect(() => doc.atPath("l").insertKey("z", 2, { index: 0 })).toThrow(/not an object/);
    });

    /**
     * A document with no text puts the key in place too, by moving the keys after it.
     *
     * createDocument({ a: 1, b: 2 }).root().insertKey("z", 0, { after: "a" }) -> keys a, z, b
     */
    it("should insert a key in place in a value document", () => {
        const doc = createDocument({ a: 1, b: 2 });

        doc.root().insertKey("z", 0, { after: "a" });

        expect(Object.keys(doc.value() as object)).toEqual(["a", "z", "b"]);
        expect(doc.root().entrySource()).toBeUndefined();
    });
});

describe("reordering entries", () => {
    /**
     * Sorting keys or items moves each one's block: its comment lines above and the comment on its
     * line. Blank lines stay where they are, between the same places, so sorting back gives the
     * original text byte for byte.
     *
     * "# bee\nb: 1\n\n# ay\na: 2\n"  sortKeys -> "# ay\na: 2\n\n# bee\nb: 1\n"
     */
    it("should move each key and item with its comment lines, leaving blank lines in place", () => {
        const yaml = "# bee\nb: 1 # one\n\n# ay\na: 2\n";
        const sorted = edit(yaml, "yaml", (doc) => doc.root().sortKeys());

        expect(sorted).toBe("# ay\na: 2\n\n# bee\nb: 1 # one\n");
        expect(edit(sorted, "yaml", (doc) => doc.root().sortKeys((x, y) => (x < y ? 1 : -1)))).toBe(yaml);

        const jsonc = '{\n  // bee\n  "b": 1, // one\n\n  /* ay */\n  "a": 2\n}\n';

        expect(edit(jsonc, "jsonc", (doc) => doc.root().sortKeys())).toBe('{\n  /* ay */\n  "a": 2,\n\n  // bee\n  "b": 1 // one\n}\n');

        const list = "list:\n  # bee\n  - b\n  # sea\n  - c\n  # ay\n  - a\n";

        expect(edit(list, "yaml", (doc) => doc.atPath("list").sort())).toBe("list:\n  # ay\n  - a\n  # bee\n  - b\n  # sea\n  - c\n");
        expect(edit('[\n  // bee\n  "b",\n  // ay\n  "a",\n]\n', "jsonc", (doc) => doc.root().sort())).toBe('[\n  // ay\n  "a",\n  // bee\n  "b",\n]\n');
    });

    /**
     * Moving one key or item carries its block the same way, and the patches recorded are the
     * primitives that make the same change.
     *
     * "a: 1\n# about b\nb: 2\nc: 3\n"  moveKeyLast b -> "a: 1\nc: 3\n# about b\nb: 2\n"
     */
    it("should move one key or item with its block, recording the primitives", () => {
        const doc = parseDocument("a: 1\n# about b\nb: 2\nc: 3\n", "yaml");

        doc.root().moveKeyLast("b");

        expect(doc.toString()).toBe("a: 1\nc: 3\n# about b\nb: 2\n");
        expect(doc.patches().patches).toEqual([{ name: "moveKeyLast", path: "", patches: [{ op: "deleteKey", path: "", key: "b" }, { op: "setKey", path: "", key: "b", value: 2 }] }]);

        expect(edit("l:\n  - a\n  # about b\n  - b # bee\n", "yaml", (doc) => doc.atPath("l").move(1, 0))).toBe("l:\n  # about b\n  - b # bee\n  - a\n");
        expect(edit("a: 1\nb: 2", "yaml", (doc) => doc.root().moveKeyFirst("b"))).toBe("b: 2\na: 1");
    });
});

describe("restoreValueSource()", () => {
    /**
     * A value put back from its source keeps its old layout: a JSONC list on one line comes back
     * on one line, where new text would be spread over several.
     *
     * '"single": "only"'  restoreValueSource(["only"], '["only"]') -> '"single": ["only"]'
     */
    it("should write a value back as it was written", () => {
        const text = '{\n    "single": ["only"],\n    "x": 1\n}\n';
        const doc = parseDocument(text, "jsonc");
        const source = doc.atPath("single").valueSource()!;

        doc.atPath("single").set("only");

        expect(source).toBe('["only"]');
        expect(edit(doc.toString(), "jsonc", (again) => again.atPath("single").restoreValueSource(["only"], source))).toBe(text);

        const yaml = "single:   [only] # one\nx: 1\n";

        expect(parseDocument(yaml, "yaml").atPath("single").valueSource()).toBe("   [only]");
        expect(edit("single: only # one\nx: 1\n", "yaml", (again) => again.atPath("single").restoreValueSource(["only"], "   [only]"))).toBe(yaml);
        // A source that does not hold the value is not used.
        expect(edit(text, "jsonc", (again) => again.atPath("x").restoreValueSource(2, "1"))).toBe(text.replace('"x": 1', '"x": 2'));
    });
});
