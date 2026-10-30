import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { isPatch, flattenPatchSet } from "./patch-set.js";
import { parseJsoncText } from "./jsonc-text.js";
import { parseDocument, type TextDocument } from "./text-document.js";
import type { DocumentFormat } from "./types.js";

/**
 * Every node operation ("The Document-Editing Package"), run on the same data in each
 * format. For each: the value is right, every change is a primitive patch, comments and
 * untouched lines survive, and an untouched file prints back byte for byte.
 */

const FILES: Record<DocumentFormat, string> = {
    json: `{
  "name": "demo",
  "tools": {
    "codex": { "command": "codex" },
    "claude": { "command": "claude" }
  },
  "compilation": {
    "targets": [
      { "id": "skills" },
      { "id": "diagrams" },
      { "id": "memories" }
    ],
    "tags": ["a", "b", "a"]
  }
}
`,
    jsonc: `// The project's config
{
  "name": "demo", // the project name
  "tools": {
    "codex": { "command": "codex" },
    "claude": { "command": "claude" } /* the default harness */
  },
  "compilation": {
    // what gets compiled
    "targets": [
      { "id": "skills" },
      { "id": "diagrams" },
      { "id": "memories" },
    ],
    "tags": ["a", "b", "a"],
  },
}
`,
    yaml: `# The project's config
name: demo # the project name
tools:
  codex:
    command: codex
  claude:
    command: claude # the default harness
compilation:
  # what gets compiled
  targets:
    - id: skills
    - id: diagrams
    - id: memories
  tags: [a, b, a]
`,
};

function valueOf(text: string, format: DocumentFormat): unknown {
    return format === "yaml" ? parseYaml(text) : parseJsoncText(text);
}

function open(format: DocumentFormat): TextDocument {
    return parseDocument(FILES[format], format);
}

/** Checks the text agrees with the value, the comments survive, and every change was a primitive. */
function checked(doc: TextDocument, format: DocumentFormat): string {
    const text = doc.toString();

    expect(valueOf(text, format)).toEqual(doc.value());

    if (format === "jsonc") {
        expect(text).toContain("// The project's config");
        expect(text).toContain("/* the default harness */");
    }

    if (format === "yaml") {
        expect(text).toContain("# The project's config");
        expect(text).toContain("# the default harness");
    }

    for (const patch of flattenPatchSet(doc.patches())) {
        expect(isPatch(patch)).toBe(true);
    }

    return text;
}

describe.each(["json", "jsonc", "yaml"] as const)("every node operation on %s", (format) => {
    /** An untouched document prints back exactly as it was read, byte for byte. */
    it("should print an untouched file back byte for byte", () => {
        expect(open(format).toString()).toBe(FILES[format]);

        const doc = open(format);

        doc.atPath("compilation.targets").get();
        doc.atPath("tools").keys();
        expect(doc.toString()).toBe(FILES[format]);
    });

    /** exists, type, isArray, isObject, get, valueOr, keys, length and atIndex read without changing anything. */
    it("should inspect values", () => {
        const doc = open(format);
        const targets = doc.atPath("compilation.targets");

        expect(targets.exists()).toBe(true);
        expect(doc.atPath("nope").exists()).toBe(false);
        expect(targets.type()).toBe("array");
        expect(doc.atPath("nope").type()).toBe("missing");
        expect(targets.isArray()).toBe(true);
        expect(doc.atPath("tools").isObject()).toBe(true);
        expect(doc.atPath("name").get()).toBe("demo");
        expect(doc.atPath("nope").valueOr("fallback")).toBe("fallback");
        expect(doc.atPath("tools").keys()).toEqual(["codex", "claude"]);
        expect(targets.length()).toBe(3);
        expect(targets.atIndex(1).get()).toEqual({ id: "diagrams" });
        expect(doc.patches().patches).toEqual([]);
        expect(doc.toString()).toBe(FILES[format]);
    });

    /** set changes one value in place and leaves every other line alone. */
    it("should set a value", () => {
        const doc = open(format);

        doc.atPath("name").set("renamed");
        doc.atPath("tools.claude.model").set("opus");

        const text = checked(doc, format);

        expect(doc.atPath("name").get()).toBe("renamed");
        expect(doc.atPath("tools.claude").get()).toEqual({ command: "claude", model: "opus" });
        expect(text).toContain(format === "yaml" ? "  tags: [a, b, a]\n" : '"tags": ["a", "b", "a"]');
        expect(text).toContain(format === "yaml" ? "    - id: diagrams\n" : '{ "id": "diagrams" }');
    });

    /** delete removes a key; rename renames one, keeping its place. */
    it("should delete and rename keys", () => {
        const doc = open(format);

        doc.atPath("tools.codex").delete();
        doc.atPath("tools.claude").rename("anthropic");
        checked(doc, format);
        expect(doc.atPath("tools").get()).toEqual({ anthropic: { command: "claude" } });
    });

    /** merge sets key by key and joins arrays; replace sets a value whole. */
    it("should merge and replace", () => {
        const doc = open(format);

        doc.atPath("compilation").merge({ tags: ["c"], overwriteUntracked: false });
        doc.atPath("tools.codex").replace({ command: "codex-beta" });
        checked(doc, format);
        expect(doc.atPath("compilation.tags").get()).toEqual(["a", "b", "a", "c"]);
        expect(doc.atPath("compilation.overwriteUntracked").get()).toBe(false);
        expect(doc.atPath("tools.codex").get()).toEqual({ command: "codex-beta" });
        expect(doc.atPath("compilation.targets").length()).toBe(3);
    });

    /** append, prepend, insertAt and removeAt edit arrays item by item. */
    it("should append, prepend, insert and remove items", () => {
        const doc = open(format);
        const targets = doc.atPath("compilation.targets");

        targets.append({ id: "last" });
        targets.prepend({ id: "first" });
        targets.insertAt(2, { id: "second" });
        targets.removeAt(3);
        checked(doc, format);
        expect(targets.get()).toEqual([{ id: "first" }, { id: "skills" }, { id: "second" }, { id: "memories" }, { id: "last" }]);
    });

    /** removeWhere removes every match, highest index first; upsertWhere replaces a match or appends. */
    it("should remove, upsert and find by predicate", () => {
        const doc = open(format);
        const targets = doc.atPath("compilation.targets");

        targets.removeWhere((target) => target.id !== "diagrams");

        expect(flattenPatchSet(doc.patches()).map((patch) => patch.op === "removeIndex" && patch.index)).toEqual([2, 0]);

        targets.upsertWhere((target) => target.id === "diagrams", { id: "diagrams", outputDir: "docs" });
        targets.upsertWhere((target) => target.id === "new", { id: "new" });
        targets.findWhere((target) => target.id === "new")!.atPath("enabled").set(true);
        expect(targets.findWhere((target) => target.id === "missing")).toBeUndefined();
        checked(doc, format);
        expect(targets.get()).toEqual([{ id: "diagrams", outputDir: "docs" }, { id: "new", enabled: true }]);
    });

    /** move moves an item; dedupe removes repeats, keeping the first of each. */
    it("should move and dedupe items", () => {
        const doc = open(format);

        doc.atPath("compilation.targets").move(0, 2);
        doc.atPath("compilation.tags").dedupe();
        checked(doc, format);
        expect(doc.atPath("compilation.targets").get()).toEqual([{ id: "diagrams" }, { id: "memories" }, { id: "skills" }]);
        expect(doc.atPath("compilation.tags").get()).toEqual(["a", "b"]);
    });

    /** doc.root().merge(data) applies a whole layer of data surgically. */
    it("should merge data at the root", () => {
        const doc = open(format);

        doc.root().merge({ name: "merged", plugins: { load: ["sous-plugin-bun"] }, compilation: { targets: [{ id: "extra" }] } });
        checked(doc, format);
        expect(doc.atPath("name").get()).toBe("merged");
        expect(doc.atPath("plugins.load").get()).toEqual(["sous-plugin-bun"]);
        expect(doc.atPath("compilation.targets").length()).toBe(4);
        expect(doc.atPath("tools").keys()).toEqual(["codex", "claude"]);
    });
});
