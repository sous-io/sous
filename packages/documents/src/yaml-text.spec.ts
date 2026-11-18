import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { parseDocument, type TextDocument } from "./text-document.js";
import { detectYamlStyle, reprintYaml } from "./yaml-text.js";

/** A hand-kept YAML file: odd spacing, mixed quoting, block and flow style, a block scalar, blank lines. */
const SETTINGS = `# Settings, kept by hand
version: 1   # spacing kept

name: 'demo'
env:
    MODE: "strict"
    LEVEL: 3

permissions:
    - "Bash(git:*)"
    - 'Read'
tags: [a,  b]
flow: {x: 1, y: 2}
notes: |
    line one
    line two
empty:
list:
    - a: 1
      b: 2
    - plain
`;

/** Edits a YAML text, checks it was surgical and reads back as the document's value, and returns it. */
function edit(text: string, change: (doc: TextDocument) => void): string {
    const doc = parseDocument(text, "yaml");

    change(doc);

    const result = doc.toString();

    expect(doc.reprinted()).toBe(false);
    expect(parseYaml(result) ?? {}).toEqual(doc.value());

    return result;
}

describe("TextDocument (surgical YAML)", () => {
    /**
     * Setting a scalar should replace only the value, keeping its quoting style, the spacing
     * before a comment, and a block scalar's style.
     *
     * version: 1   # spacing kept   ->   version: 2   # spacing kept
     * name: 'demo'                  ->   name: 'other'
     */
    it("should set scalars in place, keeping their style", () => {
        const text = edit(SETTINGS, (doc) => {
            doc.atPath("version").set(2);
            doc.atPath("name").set("other");
            doc.atPath("env.MODE").set("loose");
            doc.atPath("notes").set("one\ntwo");
        });

        expect(text).toBe(SETTINGS
            .replace("version: 1   #", "version: 2   #")
            .replace("name: 'demo'", "name: 'other'")
            .replace('MODE: "strict"', 'MODE: "loose"')
            .replace("notes: |\n    line one\n    line two\n", "notes: |-\n    one\n    two\n"));
    });

    /**
     * A new key should be one new entry after the last key of its map, in that map's
     * indentation; missing maps are created around it; a flow map gains an inline entry.
     */
    it("should add keys after the last key of their map", () => {
        const text = edit(SETTINGS, (doc) => {
            doc.atPath("env.NEW").set("x y");
            doc.atPath("flow.z").set(3);
            doc.atPath("deep.er.key").set(true);
        });

        expect(text).toBe(SETTINGS
            .replace("    LEVEL: 3\n", "    LEVEL: 3\n    NEW: x y\n")
            .replace("{x: 1, y: 2}", "{x: 1, y: 2, z: 3}")
            + "deep:\n    er:\n        key: true\n");
    });

    /**
     * List items should be added and removed one line at a time, in the list's own indentation
     * (here, not indented under its key); a flow list keeps its spacing; a value is quoted only
     * when it must be.
     */
    it("should add and remove list items", () => {
        const text = edit(SETTINGS, (doc) => {
            doc.atPath("permissions").append("Bash(ls:*)");
            doc.atPath("permissions").prepend("First");
            doc.atPath("tags").append("c,d");
            doc.atPath("list").insertAt(1, { c: 3 });
            doc.atPath("list").removeAt(0);
        });

        expect(text).toBe(SETTINGS
            .replace("permissions:\n", "permissions:\n    - First\n")
            .replace("    - 'Read'\n", "    - 'Read'\n    - Bash(ls:*)\n")
            .replace("[a,  b]", '[a,  b, "c,d"]')
            .replace("    - a: 1\n      b: 2\n", "    - c: 3\n"));
    });

    /**
     * Deleting should remove only the entry's own lines, leaving blank lines and comments
     * around it; the first key of a map inside a list item gives its place to the next key.
     */
    it("should delete keys and items", () => {
        const text = edit(SETTINGS, (doc) => {
            doc.atPath("env.LEVEL").delete();
            doc.atPath("flow.x").delete();
            doc.atPath("tags[1]").delete();
            doc.atPath("name").delete();
            doc.atPath("list[0].a").delete();
        });

        expect(text).toBe(SETTINGS
            .replace("    LEVEL: 3\n", "")
            .replace("{x: 1, y: 2}", "{y: 2}")
            .replace("[a,  b]", "[a]")
            .replace("name: 'demo'\n", "")
            .replace("    - a: 1\n      b: 2\n", "    - b: 2\n"));
    });

    /**
     * A map or list that loses its last entry should be written `{}` or `[]`, since an empty
     * block reads as null; an empty value should become a block when given one.
     */
    it("should write emptied collections as {} and [], and fill empty values", () => {
        const emptied = edit(SETTINGS, (doc) => {
            doc.atPath("permissions").removeAt(0);
            doc.atPath("permissions").removeAt(0);
            doc.atPath("flow").set({});
            doc.atPath("list[0]").set({ a: 1 });
            doc.atPath("list[0].a").delete();
        });

        expect(emptied).toBe(SETTINGS
            .replace("permissions:\n    - \"Bash(git:*)\"\n    - 'Read'\n", "permissions: []\n")
            .replace("{x: 1, y: 2}", "{}")
            .replace("    - a: 1\n      b: 2\n", "    - {}\n"));

        const filled = edit(SETTINGS, (doc) => {
            doc.atPath("empty").set({ k: "v" });
            doc.atPath("flow").set({});
            doc.atPath("flow.a").set(1);
            doc.atPath("permissions").set([]);
            doc.atPath("permissions").append("x");
        });

        expect(filled).toBe(SETTINGS
            .replace("empty:\n", "empty:\n    k: v\n")
            .replace("flow: {x: 1, y: 2}\n", "flow:\n    a: 1\n")
            .replace("permissions:\n    - \"Bash(git:*)\"\n    - 'Read'\n", "permissions:\n    - x\n"));
    });

    /**
     * A scalar becoming a block should keep the comment that followed it on its line.
     *
     * version: 1   # spacing kept   ->   version:   # spacing kept
     *                                       - 1
     */
    it("should turn a scalar into a block below its comment", () => {
        const text = edit("version: 1 # note\nnext: 2\n", (doc) => doc.atPath("version").set({ major: 1 }));

        expect(text).toBe("version: # note\n  major: 1\nnext: 2\n");
    });

    /**
     * Renaming should change only the key's text, keeping its quoting; renaming onto an
     * existing key removes that key.
     */
    it("should rename keys in place", () => {
        const text = edit(SETTINGS, (doc) => {
            doc.atPath("name").rename("title");
            doc.atPath("flow.x").rename("y");
        });

        expect(text).toBe(SETTINGS.replace("name: 'demo'", "title: 'demo'").replace("{x: 1, y: 2}", "{y: 1}"));
        expect(edit("'a': 1\nb: 2\n", (doc) => doc.atPath("a").rename("c"))).toBe("'c': 1\nb: 2\n");
    });

    /**
     * Moving a key or an item, or sorting, should move its lines whole, comments on them
     * included, and leave every other line alone.
     */
    it("should move keys and items with their own text", () => {
        const moved = edit(SETTINGS, (doc) => doc.atPath("list").move(0, 1));

        expect(moved).toBe(SETTINGS.replace("    - a: 1\n      b: 2\n    - plain\n", "    - plain\n    - a: 1\n      b: 2\n"));

        const keys = edit("a: 1 # first\nb: 'two'\nc:\n  - x\n", (doc) => doc.root().moveKeyFirst("c"));

        expect(keys).toBe("c:\n  - x\na: 1 # first\nb: 'two'\n");

        const sorted = edit("tags:\n  - b # bee\n  - 'c'\n  - a\n", (doc) => doc.atPath("tags").sort());

        expect(sorted).toBe("tags:\n  - a\n  - b # bee\n  - 'c'\n");
    });

    /**
     * A file whose lists sit right under their key (`key:\n- a`) should get new lists the same way.
     */
    it("should write lists at the file's depth", () => {
        expect(edit("a:\n- x\n", (doc) => {
            doc.atPath("a").append("y");
            doc.atPath("b").set(["z"]);
            doc.atPath("c").set({ d: [1] });
        })).toBe("a:\n- x\n- y\nb:\n- z\nc:\n  d:\n  - 1\n");
    });

    /** Windows line endings should be kept, and new lines written with them. */
    it("should keep CRLF line endings", () => {
        expect(edit("a:\r\n  - 1\r\n", (doc) => {
            doc.atPath("a").append(2);
            doc.atPath("b").set({ c: 1 });
        })).toBe("a:\r\n  - 1\r\n  - 2\r\nb:\r\n  c: 1\r\n");
    });

    /** Odd shapes: no final line break, a root list, document markers, an empty file, a lone root key. */
    it("should handle the edges of a document", () => {
        expect(edit("a: 1", (doc) => doc.atPath("b").set(1))).toBe("a: 1\nb: 1\n");
        expect(edit("- x\n- y\n", (doc) => {
            doc.root().append("z");
            doc.atPath("[0]").delete();
        })).toBe("- y\n- z\n");
        expect(edit("- x\n", (doc) => doc.atPath("[0]").delete())).toBe("[]\n");
        expect(edit("---\na: 1\n...\n", (doc) => doc.atPath("b").set(1))).toBe("---\na: 1\nb: 1\n...\n");
        expect(edit("# only a comment\n", (doc) => doc.atPath("a").set("x"))).toBe("# only a comment\na: x\n");
        expect(edit("{}\n", (doc) => doc.atPath("a").set(1))).toBe("a: 1\n");
        expect(edit("# keep\na: 1\n", (doc) => doc.atPath("a").delete())).toBe("# keep\n");
        expect(edit("- - a\n  - b\n", (doc) => doc.atPath("[0]").prepend("z"))).toBe("- - z\n  - a\n  - b\n");
        expect(edit("- - a\n  - b\n", (doc) => doc.atPath("[0]").removeAt(0))).toBe("- - b\n");
    });

    /**
     * New strings should be quoted the way most strings in the file are.
     */
    it("should quote new strings like the file does", () => {
        expect(edit('a: "x"\nb: "y"\n', (doc) => doc.atPath("c").set("z"))).toBe('a: "x"\nb: "y"\nc: "z"\n');
        expect(edit("a: 'x'\n", (doc) => doc.atPath("list").set(["z"]))).toBe("a: 'x'\nlist:\n  - 'z'\n");
    });

    /**
     * An edit the editor cannot make line by line, here a node an alias points at, should
     * fall back to reprinting the whole document, and say so.
     */
    it("should fall back to a reprint when it cannot edit surgically", () => {
        const doc = parseDocument("base: &b\n  x: 1\nother: *b\n", "yaml");

        doc.atPath("base.x").set(2);
        expect(doc.reprinted()).toBe(true);
        expect(doc.toString()).toBe(reprintYaml("base: &b\n  x: 1\nother: *b\n", { op: "setKey", path: "base", key: "x", value: 2 }));

        const explicit = parseDocument("? a\n: 1\n", "yaml");

        explicit.atPath("a").set(2);
        expect(explicit.reprinted()).toBe(true);
        expect(explicit.value()).toEqual({ a: 2 });
    });
});

describe("detectYamlStyle()", () => {
    /**
     * detectYamlStyle should read the indentation, whether lists are indented under their key,
     * the usual quoting and the line ending.
     *
     * detectYamlStyle("a:\n    b: 'x'\n");   // { indent: 4, seqIndent: 2, stringType: "QUOTE_SINGLE", eol: "\n" }
     */
    it("should read how a file is written", () => {
        expect(detectYamlStyle("a:\n    b: 'x'\n")).toEqual({ indent: 4, seqIndent: 2, stringType: "QUOTE_SINGLE", eol: "\n" });
        expect(detectYamlStyle("a:\r\n- \"x\"\r\n")).toEqual({ indent: 2, seqIndent: 0, stringType: "QUOTE_DOUBLE", eol: "\r\n" });
        expect(detectYamlStyle("a: [1\n")).toEqual({ indent: 2, seqIndent: 2, stringType: "PLAIN", eol: "\n" });
    });
});
