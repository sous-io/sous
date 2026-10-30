import { describe, expect, it } from "vitest";
import { parseDocument } from "./text-document.js";
import { parseJsoncText } from "./jsonc-text.js";
import type { DocumentFormat } from "./types.js";

/** A managed conf.d file, as sous writes it, with a user's comments added. */
const SUBSCRIPTIONS = `// Managed by sous: subscriptions this project follows.
{
    "subscriptions": {
        // Browser automation, kept on for everyone
        "tool-usage/automated-browser-tasks": {
            "range": "^2.1.0",
            "prerelease": false, // never take betas
            "alwaysPull": true,
            "addedAt": "2026-10-12T14:03:00Z",
            "addedBy": "user"
        },
        "workflow/github-projects": {
            "range": "^1.3.0"
        }
    },
    /* repos are added by sous repo add */
    "repos": []
}
`;

/** A YAML recipe manifest with comments. */
const RECIPE = `# The recipe manifest
name: github-projects
version: 1.3.0 # bumped by release

# Variables the recipe asks for
variables:
  - name: githubProjectId # the board
    required: true
  - name: owner

plugin:
  bundle: plugin/index.js
`;

/** Edits a document and returns its text. */
function edit(text: string, format: DocumentFormat, change: (doc: ReturnType<typeof parseDocument>) => void): string {
    const doc = parseDocument(text, format);

    change(doc);

    if (format !== "yaml") {
        // The text and the value must always agree.
        expect(parseJsoncText(doc.toString())).toEqual(doc.value());
    }

    return doc.toString();
}

describe("parseDocument()", () => {
    /**
     * parseDocument should read JSON, JSONC (comments, trailing commas) and YAML, with empty text
     * as `{}`, and toString() should give the text back untouched when nothing changed.
     */
    it("should parse every format and keep untouched text", () => {
        const doc = parseDocument(SUBSCRIPTIONS, "jsonc");

        expect(doc.format).toBe("jsonc");
        expect(doc.atPath(["subscriptions", "workflow/github-projects", "range"]).get()).toBe("^1.3.0");
        expect(doc.toString()).toBe(SUBSCRIPTIONS);
        expect(parseDocument(RECIPE, "yaml").atPath("variables[0].name").get()).toBe("githubProjectId");
        expect(parseDocument(RECIPE, "yaml").toString()).toBe(RECIPE);
        expect(parseDocument("", "json").value()).toEqual({});
        expect(parseDocument("", "yaml").value()).toEqual({});
        expect(parseDocument('{"a": [1,],}', "jsonc").value()).toEqual({ a: [1] });
    });

    /**
     * parseDocument should name the line of a syntax error.
     *
     * parseDocument('{\n  "a": }', "json");   // throws: ... a syntax error at line 2 ...
     */
    it("should reject invalid text", () => {
        expect(() => parseDocument('{\n  "a": }', "json")).toThrow("line 2");
        expect(() => parseDocument("a: [1\nb", "yaml")).toThrow("The YAML text is not valid");
    });
});

describe("TextDocument (JSONC)", () => {
    /**
     * Setting an existing value should replace only that value, keeping the comment beside it.
     *
     * doc.atPath(["subscriptions", "tool-usage/automated-browser-tasks", "prerelease"]).set(true);
     * // "prerelease": true, // never take betas
     */
    it("should set an existing value in place", () => {
        const text = edit(SUBSCRIPTIONS, "jsonc", (doc) =>
            doc.atPath(["subscriptions", "tool-usage/automated-browser-tasks", "prerelease"]).set(true));

        expect(text).toBe(SUBSCRIPTIONS.replace('"prerelease": false,', '"prerelease": true,'));
    });

    /**
     * Adding a key should add one line after the last key, in the file's indentation, keeping the
     * user's other entries exactly as they were (edits touch only the changed entry).
     */
    it("should add a key as a new line, keeping everything else", () => {
        const text = edit(SUBSCRIPTIONS, "jsonc", (doc) =>
            doc.atPath(["subscriptions", "tool-usage/automated-browser-tasks", "enabled"]).set(false));

        expect(text).toBe(SUBSCRIPTIONS.replace(
            '"addedBy": "user"\n',
            '"addedBy": "user",\n            "enabled": false\n',
        ));
    });

    /**
     * Adding a subscription should add one entry, with nested objects in the file's layout.
     */
    it("should add a nested object", () => {
        const text = edit(SUBSCRIPTIONS, "jsonc", (doc) =>
            doc.atPath(["subscriptions", "core/basics"]).set({ range: "^1.0.0", addedBy: "sous" }));

        expect(text).toBe(SUBSCRIPTIONS.replace(
            `            "range": "^1.3.0"
        }
    },`,
            `            "range": "^1.3.0"
        },
        "core/basics": {
            "range": "^1.0.0",
            "addedBy": "sous"
        }
    },`,
        ));
    });

    /**
     * Setting a key under missing objects should create them in one new entry.
     */
    it("should create missing objects", () => {
        const text = edit('{\n  "a": 1\n}\n', "json", (doc) => doc.atPath("b.c.d").set(true));

        expect(text).toBe('{\n  "a": 1,\n  "b": {\n    "c": {\n      "d": true\n    }\n  }\n}\n');
    });

    /**
     * Deleting a key should remove its line, with the comment on it, and fix the comma of the
     * entry before when it was the last.
     */
    it("should delete keys with their lines", () => {
        const middle = edit(SUBSCRIPTIONS, "jsonc", (doc) =>
            doc.atPath(["subscriptions", "tool-usage/automated-browser-tasks", "prerelease"]).delete());

        expect(middle).toBe(SUBSCRIPTIONS.replace('            "prerelease": false, // never take betas\n', ""));

        const last = edit(SUBSCRIPTIONS, "jsonc", (doc) =>
            doc.atPath(["subscriptions", "tool-usage/automated-browser-tasks", "addedBy"]).delete());

        expect(last).toBe(SUBSCRIPTIONS.replace('"addedAt": "2026-10-12T14:03:00Z",\n            "addedBy": "user"\n', '"addedAt": "2026-10-12T14:03:00Z"\n'));

        const only = edit(SUBSCRIPTIONS, "jsonc", (doc) =>
            doc.atPath(["subscriptions", "workflow/github-projects", "range"]).delete());

        expect(only).toContain('"workflow/github-projects": {}');
        expect(edit('{"a": 1}', "json", (doc) => doc.atPath("missing").delete())).toBe('{"a": 1}');
    });

    /**
     * Renaming a key should change only the key's text; an existing key of the new name is
     * replaced.
     *
     * doc.atPath(["subscriptions", "workflow/github-projects"]).rename("workflow/projects");
     */
    it("should rename keys in place", () => {
        const text = edit(SUBSCRIPTIONS, "jsonc", (doc) =>
            doc.atPath(["subscriptions", "workflow/github-projects"]).rename("workflow/projects"));

        expect(text).toBe(SUBSCRIPTIONS.replace('"workflow/github-projects"', '"workflow/projects"'));

        const clash = edit('{\n    "a": 1,\n    "b": 2\n}', "json", (doc) => doc.atPath("a").rename("b"));

        expect(JSON.parse(clash)).toEqual({ b: 1 });
    });

    /**
     * Array primitives should edit one item at a time: insert on its own line in a multi-line
     * array, inline in a one-line array, and remove items with their commas.
     */
    it("should edit multi-line and inline arrays", () => {
        const multi = '{\n    "list": [\n        "one", // first\n        "two"\n    ],\n    "inline": [1, 2]\n}\n';

        expect(edit(multi, "jsonc", (doc) => doc.atPath("list").append("three")))
            .toBe('{\n    "list": [\n        "one", // first\n        "two",\n        "three"\n    ],\n    "inline": [1, 2]\n}\n');
        expect(edit(multi, "jsonc", (doc) => doc.atPath("list").prepend("zero")))
            .toBe('{\n    "list": [\n        "zero",\n        "one", // first\n        "two"\n    ],\n    "inline": [1, 2]\n}\n');
        expect(edit(multi, "jsonc", (doc) => doc.atPath("list").insertAt(1, { z: 1 })))
            .toBe('{\n    "list": [\n        "one", // first\n        {\n            "z": 1\n        },\n        "two"\n    ],\n    "inline": [1, 2]\n}\n');
        expect(edit(multi, "jsonc", (doc) => doc.atPath("list").removeAt(1)))
            .toBe('{\n    "list": [\n        "one" // first\n    ],\n    "inline": [1, 2]\n}\n');
        expect(edit(multi, "jsonc", (doc) => doc.atPath("list").removeAt(0)))
            .toBe('{\n    "list": [\n        "two"\n    ],\n    "inline": [1, 2]\n}\n');
        expect(edit(multi, "jsonc", (doc) => doc.atPath("list[1]").set("TWO")))
            .toBe(multi.replace('"two"', '"TWO"'));
        expect(edit(multi, "jsonc", (doc) => doc.atPath("inline").append(3))).toBe(multi.replace("[1, 2]", "[1, 2, 3]"));
        expect(edit(multi, "jsonc", (doc) => doc.atPath("inline").prepend(0))).toBe(multi.replace("[1, 2]", "[0, 1, 2]"));
        expect(edit(multi, "jsonc", (doc) => doc.atPath("inline").removeAt(0))).toBe(multi.replace("[1, 2]", "[2]"));
        expect(edit(multi, "jsonc", (doc) => doc.atPath("inline").removeAt(1))).toBe(multi.replace("[1, 2]", "[1]"));
        expect(edit(multi, "jsonc", (doc) => doc.atPath("inline").removeWhere(() => true))).toBe(multi.replace("[1, 2]", "[]"));
    });

    /**
     * Inserting into an empty array or object should write the item in the file's layout.
     */
    it("should fill empty containers", () => {
        expect(edit(SUBSCRIPTIONS, "jsonc", (doc) => doc.atPath("repos").append("github.com/acme/recipes")))
            .toBe(SUBSCRIPTIONS.replace('"repos": []', '"repos": ["github.com/acme/recipes"]'));
        expect(edit(SUBSCRIPTIONS, "jsonc", (doc) => doc.atPath("repos").append({ url: "x" })))
            .toBe(SUBSCRIPTIONS.replace('"repos": []', '"repos": [\n        {\n            "url": "x"\n        }\n    ]'));
        expect(edit("{}", "json", (doc) => doc.atPath("a").set(1))).toBe('{\n    "a": 1\n}');
        expect(edit('{\n  "list": [\n  ]\n}', "json", (doc) => doc.atPath("list").append(1))).toBe('{\n  "list": [\n    1\n  ]\n}');
        expect(edit('{"a": {}}', "json", (doc) => doc.atPath("a.b").set([]))).toBe('{"a": {\n    "b": []\n}}');
    });

    /**
     * Appending to a missing array should create it, as one new key holding the item.
     */
    it("should create missing arrays", () => {
        expect(edit('{\n    "a": 1\n}', "json", (doc) => doc.atPath("compilation.targets").append({ id: "x" })))
            .toBe('{\n    "a": 1,\n    "compilation": {\n        "targets": [\n            {\n                "id": "x"\n            }\n        ]\n    }\n}');
    });

    /**
     * Edits should keep trailing commas, inline objects and comments after the last entry.
     */
    it("should keep trailing commas and inline layouts", () => {
        expect(edit('{\n    "a": 1,\n}', "jsonc", (doc) => doc.atPath("b").set(2))).toBe('{\n    "a": 1,\n    "b": 2,\n}');
        expect(edit('{"a": 1}', "json", (doc) => doc.atPath("b").set(2))).toBe('{"a": 1, "b": 2}');
        expect(edit('{"a": 1,}', "jsonc", (doc) => doc.atPath("b").set(2))).toBe('{"a": 1, "b": 2,}');
        expect(edit('{\n    "a": 1 // note\n}', "jsonc", (doc) => doc.atPath("b").set(2))).toBe('{\n    "a": 1, // note\n    "b": 2\n}');
        expect(edit('{\n    "a": 1}', "json", (doc) => doc.atPath("b").set(2))).toBe('{\n    "a": 1,\n    "b": 2}');
        expect(edit('{\n    "a": 1,}', "jsonc", (doc) => doc.atPath("b").set(2))).toBe('{\n    "a": 1,\n    "b": 2,}');
        expect(edit('{\n    "a": 1, "b": 2,\n    "c": 3\n}', "json", (doc) => doc.atPath("b").delete())).toBe('{\n    "a": 1,\n    "c": 3\n}');
        expect(edit('{ "b": 2,\n    "c": 3\n}', "json", (doc) => doc.atPath("b").delete())).toBe('{ "c": 3\n}');
        expect(edit('{\n    "a": 1, /* x */ "b": 2\n}', "jsonc", (doc) => doc.atPath("b").delete())).toBe('{\n    "a": 1\n}');
        expect(edit('{\n    "a": 1,\n    "b": 2,\n}', "jsonc", (doc) => doc.atPath("b").delete())).toBe('{\n    "a": 1,\n}');
    });

    /**
     * Edits should step over block comments, and handle a closing bracket on the last item's line.
     */
    it("should handle block comments and a closing bracket on the last item's line", () => {
        expect(edit('{\n    "a": 1 /* one */\n}', "jsonc", (doc) => doc.atPath("b").set(2))).toBe('{\n    "a": 1, /* one */\n    "b": 2\n}');
        expect(edit('[\n    1,\n    2]', "json", (doc) => doc.root().removeAt(1))).toBe('[\n    1]');
        expect(edit('[\n    1, /* a */ /* b */\n    2\n]', "jsonc", (doc) => doc.root().removeAt(0))).toBe('[\n    2\n]');
    });

    /**
     * Inserting before an item that shares its line with another should go inline.
     */
    it("should insert inline before an item not at a line start", () => {
        expect(edit('[\n    1, 2\n]', "json", (doc) => doc.root().insertAt(1, 9))).toBe('[\n    1, 9, 2\n]');
    });

    /**
     * Edits should follow the file's tabs and Windows line endings.
     */
    it("should follow tabs and CRLF", () => {
        expect(edit('{\r\n\t"a": 1\r\n}\r\n', "json", (doc) => doc.atPath("b").set({ c: 1 })))
            .toBe('{\r\n\t"a": 1,\r\n\t"b": {\r\n\t\t"c": 1\r\n\t}\r\n}\r\n');
        expect(edit('{\r\n\t"a": 1,\r\n\t"b": 2\r\n}', "json", (doc) => doc.atPath("a").delete())).toBe('{\r\n\t"b": 2\r\n}');
    });

    /**
     * An empty file should be written fresh by its first edit.
     */
    it("should write an empty file fresh", () => {
        expect(edit("", "jsonc", (doc) => doc.atPath("a").set(1))).toBe('{\n    "a": 1\n}\n');
    });

    /**
     * A JSON array at the root should be edited like any array.
     */
    it("should edit a root array", () => {
        expect(edit("[1, 2]", "json", (doc) => doc.root().append(3))).toBe("[1, 2, 3]");
    });

    /**
     * A patch that cannot apply should be reported and leave the text alone.
     */
    it("should leave the text alone for a patch that cannot apply", () => {
        const doc = parseDocument(SUBSCRIPTIONS, "jsonc");

        doc.atPath("repos").removeAt(4);
        expect(doc.toString()).toBe(SUBSCRIPTIONS);
        expect(doc.problems().map((problem) => problem.message)).toEqual(["repos has 0 items, so there is no item 4 to remove."]);
    });

    /**
     * A merge at the root should touch only what it changes.
     */
    it("should merge surgically", () => {
        const text = edit(SUBSCRIPTIONS, "jsonc", (doc) => doc.root().merge({
            subscriptions: { "workflow/github-projects": { range: "^1.4.0" } },
            repos: ["github.com/acme/recipes"],
        }));

        expect(text).toBe(SUBSCRIPTIONS
            .replace('"range": "^1.3.0"', '"range": "^1.4.0"')
            .replace('"repos": []', '"repos": ["github.com/acme/recipes"]'));
    });
});

describe("TextDocument (YAML)", () => {
    /**
     * Setting a scalar should keep the comment beside it.
     *
     * doc.atPath("version").set("1.4.0");   // version: 1.4.0 # bumped by release
     */
    it("should set scalars keeping comments", () => {
        expect(edit(RECIPE, "yaml", (doc) => doc.atPath("version").set("1.4.0")))
            .toBe(RECIPE.replace("version: 1.3.0 # bumped by release", "version: 1.4.0 # bumped by release"));
    });

    /**
     * Every primitive should change only its own node, keeping the comments around it.
     */
    it("should apply every primitive", () => {
        expect(edit(RECIPE, "yaml", (doc) => doc.atPath("plugin.types").set("plugin/index.d.ts")))
            .toBe(RECIPE.replace("bundle: plugin/index.js\n", "bundle: plugin/index.js\n  types: plugin/index.d.ts\n"));
        expect(edit(RECIPE, "yaml", (doc) => doc.atPath("plugin.bundle").delete())).toBe(RECIPE.replace("plugin:\n  bundle: plugin/index.js\n", "plugin: {}\n"));
        expect(edit(RECIPE, "yaml", (doc) => doc.atPath("name").rename("id"))).toBe(RECIPE.replace("name: github-projects", "id: github-projects"));
        expect(edit(RECIPE, "yaml", (doc) => doc.atPath("variables").append({ name: "repo" })))
            .toBe(RECIPE.replace("  - name: owner\n", "  - name: owner\n  - name: repo\n"));
        expect(edit(RECIPE, "yaml", (doc) => doc.atPath("variables").prepend({ name: "first" })))
            .toBe(RECIPE.replace("variables:\n", "variables:\n  - name: first\n"));
        expect(edit(RECIPE, "yaml", (doc) => doc.atPath("variables").removeAt(1))).toBe(RECIPE.replace("  - name: owner\n", ""));
        expect(edit(RECIPE, "yaml", (doc) => doc.atPath("variables[1]").set({ name: "org" }))).toBe(RECIPE.replace("name: owner", "name: org"));
        expect(edit(RECIPE, "yaml", (doc) => doc.atPath("variables[0].required").set(false))).toBe(RECIPE.replace("required: true", "required: false"));
    });

    /**
     * Renaming onto an existing key should replace it; a missing array should be created.
     */
    it("should rename onto existing keys and create arrays", () => {
        const doc = parseDocument("a: 1\nb: 2\n", "yaml");

        doc.atPath("a").rename("b");
        doc.atPath("list").append(1);
        doc.atPath("deep.list").append("x");
        expect(doc.toString()).toBe("b: 1\nlist:\n  - 1\ndeep:\n  list:\n    - x\n");
        expect(doc.value()).toEqual({ b: 1, list: [1], deep: { list: ["x"] } });
    });

    /**
     * An empty YAML file should be filled by its first edit, and the root replaced whole.
     */
    it("should fill an empty file and replace the root", () => {
        expect(edit("", "yaml", (doc) => doc.atPath("a").set([1]))).toBe("a:\n  - 1\n");
        expect(edit("- 1\n", "yaml", (doc) => doc.root().replace([2]))).toBe("- 2\n");

        const doc = parseDocument("a: 1\n", "yaml");

        doc.atPath("a").set({ b: 1 });
        expect(doc.toString()).toBe("a:\n  b: 1\n");
    });
});
