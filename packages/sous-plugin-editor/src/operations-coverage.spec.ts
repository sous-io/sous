import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@sous-io/sous-plugin-api";
import { editorProject, type EditorProject } from "../test/engine.js";
import { change, JSONC, TEXT, YAML } from "../test/fixtures.js";
import { makeTmpDir } from "../test/helpers.js";
import { ALIASES, OPERATIONS } from "./operations.js";

let tmp: { path: string; cleanup(): void };
let project: EditorProject;

beforeEach(() => {
    tmp = makeTmpDir();
    project = editorProject(tmp.path);
});

afterEach(() => {
    tmp.cleanup();
});

/** One operation, by any of its names, and what it should make of each fixture it applies to. */
interface Case {
    readonly op: string;
    readonly params: JsonObject;
    readonly jsonc?: string;
    readonly yaml?: string;
    readonly text?: string;
}

const FILES = { jsonc: ["settings.jsonc", JSONC], yaml: ["settings.yaml", YAML], text: ["notes.txt", TEXT] } as const;

/**
 * Runs one entry through `editor.apply` three times and checks the exact text each time:
 *
 * 1. The entry is declared: the file becomes `expected`, every automatic assertion holds.
 * 2. The same entry again: nothing changes (an action acts once per declaration).
 * 3. Nothing is declared: the file is back to its original bytes.
 */
async function roundTrip(file: string, original: string, entry: JsonObject, expected: string): Promise<void> {
    project.write(file, original);

    const first = await project.apply([entry]);

    expect(first.result.ok).toBe(true);
    expect(first.warnings).toEqual([]);
    expect(project.read(file)).toBe(expected);

    const second = await project.apply([entry]);

    expect(second.result.files).toEqual([{ file, action: "unchanged" }]);
    expect(second.warnings).toEqual([]);
    expect(project.read(file)).toBe(expected);

    const removed = await project.apply([]);

    expect(removed.warnings).toEqual([]);
    expect(project.read(file)).toBe(original);
    expect(JSON.parse(project.read(".sous/sous.edits.json")!).entries).toEqual([]);
}

/** The lines of the fixtures that the cases change, so each expected text reads as a diff. */
const J = {
    mode: '"mode": "loose"',
    list: '"list": ["b", "a", "b"]',
    options: '"options": { "x": 1, "nested": { "deep": true } }',
    end: '"single": ["only"]\n}',
    people: `"people": [
        { "id": 1, "name": "ann", "tags": { "a": true } },
        { "id": 2, "name": "bob" },
        { "id": 1, "name": "ann again" }
    ]`,
};
const Y = {
    list: "list:\n  - b\n  - a\n  - b\n",
    options: "options:\n  x: 1\n  nested:\n    deep: true\n",
    people: "people:\n  - id: 1\n    name: ann\n    tags:\n      a: true\n  - id: 2\n    name: bob\n  - id: 1\n    name: ann again\n",
};
const jsonList = (...items: string[]) => change(JSONC, [J.list, `"list": [${items.map((item) => JSON.stringify(item)).join(", ")}]`]);
const yamlList = (...items: string[]) => change(YAML, [Y.list, `list:\n${items.map((item) => `  - ${item}\n`).join("")}`]);
const jsonPeople = (...items: string[]) => change(JSONC, [J.people, `"people": [\n${items.map((item) => `        ${item}`).join(",\n")}\n    ]`]);
const ANN = '{ "id": 1, "name": "ann", "tags": { "a": true } }';
const BOB = '{ "id": 2, "name": "bob" }';
const ANN_AGAIN = '{ "id": 1, "name": "ann again" }';
const yamlPeople = (...items: string[]) => change(YAML, [Y.people, `people:\n${items.join("")}`]);
const YANN = "  - id: 1\n    name: ann\n    tags:\n      a: true\n";
const YBOB = "  - id: 2\n    name: bob\n";
const YANN_AGAIN = "  - id: 1\n    name: ann again\n";
const SORTED_OPTIONS_J = change(JSONC, [J.options, '"options": { "nested": { "deep": true }, "x": 1 }']);
const SORTED_OPTIONS_Y = change(YAML, [Y.options, "options:\n  nested:\n    deep: true\n  x: 1\n"]);

const STRICT = { jsonc: change(JSONC, [J.mode, '"mode": "strict"']), yaml: change(YAML, ["mode: loose", "mode: strict"]) };
const NO_MODE = { jsonc: change(JSONC, [`    ${J.mode},\n`, ""]), yaml: change(YAML, ["mode: loose\n", ""]) };
const LEVEL = { jsonc: change(JSONC, [J.end, '"single": ["only"],\n    "level": 3\n}']), yaml: `${YAML}level: 3\n` };
const WITH_C = { jsonc: jsonList("b", "a", "b", "c"), yaml: yamlList("b", "a", "b", "c") };
const WITHOUT_B = { jsonc: jsonList("a"), yaml: yamlList("a") };
const UNIQUE = { jsonc: jsonList("b", "a"), yaml: yamlList("b", "a") };
const SORTED = { jsonc: jsonList("a", "b", "b"), yaml: yamlList("a", "b", "b") };
const Z_BEFORE_A = { jsonc: jsonList("b", "z", "a", "b"), yaml: yamlList("b", "z", "a", "b") };
const MERGED_KEYS = {
    jsonc: change(JSONC, [J.options, '"options": { "x": 2, "nested": { "deep": true }, "y": 3 }']),
    yaml: change(YAML, [Y.options, "options:\n  x: 2\n  nested:\n    deep: true\n  y: 3\n"]),
};
const ADDED_CY = {
    jsonc: jsonPeople(ANN, BOB, ANN_AGAIN, '{ "id": 3, "name": "cy" }'),
    yaml: yamlPeople(YANN, YBOB, YANN_AGAIN, "  - id: 3\n    name: cy\n"),
};
const NO_BOB = { jsonc: jsonPeople(ANN, ANN_AGAIN), yaml: yamlPeople(YANN, YANN_AGAIN) };
const NO_ANN = { jsonc: jsonPeople(BOB), yaml: yamlPeople(YBOB) };
const ROBERT = {
    jsonc: jsonPeople(ANN, '{ "id": 2, "name": "robert" }', ANN_AGAIN),
    yaml: yamlPeople(YANN, "  - id: 2\n    name: robert\n", YANN_AGAIN),
};

/** Every operation and every other name, with what it makes of the JSONC and YAML fixtures. */
const VALUE_CASES: Case[] = [
    // Any value.
    { op: "set", params: { path: "mode", value: "strict" }, ...STRICT },
    { op: "ensureValue", params: { path: "mode", value: "strict" }, ...STRICT },
    { op: "replace", params: { path: "mode", value: "strict" }, ...STRICT },
    { op: "set", params: { path: "level", value: 3, ifMissing: true }, ...LEVEL },
    { op: "setIfMissing", params: { path: "level", value: 3 }, ...LEVEL },
    { op: "ensureDefault", params: { path: "level", value: 3 }, ...LEVEL },
    { op: "ensureDefault", params: { path: "mode", value: "strict" }, jsonc: JSONC, yaml: YAML },
    { op: "setIfEquals", params: { path: "mode", value: "strict", equals: "loose" }, ...STRICT },
    { op: "setIfEquals", params: { path: "mode", value: "strict", equals: "other" }, jsonc: JSONC, yaml: YAML },
    { op: "renameKey", params: { path: "mode", name: "style" }, jsonc: change(JSONC, ['"mode":', '"style":']), yaml: change(YAML, ["mode:", "style:"]) },
    { op: "delete", params: { path: "mode" }, ...NO_MODE },
    { op: "ensureAbsent", params: { path: "mode" }, ...NO_MODE },
    { op: "deleteIfEquals", params: { path: "mode", value: "loose" }, ...NO_MODE },
    { op: "deleteIfEmpty", params: { path: "empty" }, jsonc: change(JSONC, ['    "empty": {},\n', ""]), yaml: change(YAML, ["empty: {}\n", ""]) },
    // Objects.
    { op: "merge", params: { path: "options", value: { x: 2, y: 3 } }, ...MERGED_KEYS },
    { op: "ensureKeys", params: { path: "options", value: { x: 2, y: 3 } }, ...MERGED_KEYS },
    {
        op: "deepMerge",
        params: { path: "options", value: { nested: { deep: false, extra: 1 } } },
        jsonc: change(JSONC, ['{ "deep": true }', '{ "deep": false, "extra": 1 }']),
        yaml: change(YAML, ["    deep: true\n", "    deep: false\n    extra: 1\n"]),
    },
    {
        op: "mergeIfMissing",
        params: { path: "options", value: { x: 9, y: 3 } },
        jsonc: change(JSONC, [J.options, '"options": { "x": 1, "nested": { "deep": true }, "y": 3 }']),
        yaml: change(YAML, ["    deep: true\n", "    deep: true\n  y: 3\n"]),
    },
    {
        op: "deleteKeys",
        params: { keys: ["mode", "count"] },
        jsonc: change(JSONC, [`    ${J.mode},\n`, ""], ['    "count": 1,\n', ""]),
        yaml: change(YAML, ["mode: loose\n", ""], ["count: 1\n", ""]),
    },
    {
        op: "keepOnlyKeys",
        params: { path: "options", keys: ["nested"] },
        jsonc: change(JSONC, ['{ "x": 1, "nested"', '{ "nested"']),
        yaml: change(YAML, ["  x: 1\n", ""]),
    },
    { op: "sortKeys", params: { path: "options" }, jsonc: SORTED_OPTIONS_J, yaml: SORTED_OPTIONS_Y },
    { op: "moveKeyBefore", params: { path: "options", key: "nested", anchor: "x" }, jsonc: SORTED_OPTIONS_J, yaml: SORTED_OPTIONS_Y },
    { op: "moveKeyAfter", params: { path: "options", key: "x", anchor: "nested" }, jsonc: SORTED_OPTIONS_J, yaml: SORTED_OPTIONS_Y },
    { op: "moveKeyFirst", params: { path: "options", key: "nested" }, jsonc: SORTED_OPTIONS_J, yaml: SORTED_OPTIONS_Y },
    { op: "moveKeyLast", params: { path: "options", key: "x" }, jsonc: SORTED_OPTIONS_J, yaml: SORTED_OPTIONS_Y },
    // Structure.
    { op: "ensureObject", params: { path: "scalar" }, jsonc: change(JSONC, ['"scalar": "one"', '"scalar": {}']), yaml: change(YAML, ["scalar: one", "scalar: {}"]) },
    { op: "ensureList", params: { path: "scalar" }, jsonc: change(JSONC, ['"scalar": "one"', '"scalar": []']), yaml: change(YAML, ["scalar: one", "scalar: []"]) },
    { op: "ensureList", params: { path: "fresh" }, jsonc: change(JSONC, [J.end, '"single": ["only"],\n    "fresh": []\n}']), yaml: `${YAML}fresh: []\n` },
    {
        op: "wrapInList",
        params: { path: "scalar" },
        jsonc: change(JSONC, ['"scalar": "one"', '"scalar": [\n        "one"\n    ]']),
        yaml: change(YAML, ["scalar: one", "scalar:\n  - one"]),
    },
    {
        op: "unwrapList",
        params: { path: "single" },
        jsonc: change(JSONC, ['"single": ["only"]', '"single": "only"']),
        yaml: change(YAML, ["single:\n  - only", "single: only"]),
    },
    // Lists.
    { op: "upsertWhere", params: { path: "people", match: { id: 3 }, item: { id: 3, name: "cy" } }, ...ADDED_CY },
    { op: "ensureItemWhere", params: { path: "people", match: { id: 3 }, item: { id: 3, name: "cy" } }, ...ADDED_CY },
    {
        op: "ensureItemWhere",
        params: { path: "people", match: { id: 2 }, item: { id: 2, name: "robert" } },
        ...ROBERT,
    },
    { op: "ensureIncludes", params: { path: "list", items: ["a", "c"] }, ...WITH_C },
    { op: "appendIfMissing", params: { path: "list", items: ["c"] }, ...WITH_C },
    { op: "union", params: { path: "list", items: ["a", "c"] }, ...WITH_C },
    { op: "ensureFirst", params: { path: "list", item: "a" }, jsonc: jsonList("a", "b", "b"), yaml: yamlList("a", "b", "b") },
    { op: "ensureLast", params: { path: "list", item: "a" }, jsonc: jsonList("b", "b", "a"), yaml: yamlList("b", "b", "a") },
    { op: "ensureAt", params: { path: "list", item: "c", index: 1 }, jsonc: jsonList("b", "c", "a", "b"), yaml: yamlList("b", "c", "a", "b") },
    { op: "prependIfMissing", params: { path: "list", items: ["c", "a"] }, jsonc: jsonList("c", "b", "a", "b"), yaml: yamlList("c", "b", "a", "b") },
    { op: "append", params: { path: "list", item: "a" }, jsonc: jsonList("b", "a", "b", "a"), yaml: yamlList("b", "a", "b", "a") },
    { op: "prepend", params: { path: "list", item: "z" }, jsonc: jsonList("z", "b", "a", "b"), yaml: yamlList("z", "b", "a", "b") },
    { op: "insertAt", params: { path: "list", item: "z", index: 1 }, jsonc: jsonList("b", "z", "a", "b"), yaml: yamlList("b", "z", "a", "b") },
    { op: "insertBefore", params: { path: "list", before: "a", item: "z" }, ...Z_BEFORE_A },
    { op: "insertAfter", params: { path: "list", after: "a", item: "z" }, jsonc: jsonList("b", "a", "z", "b"), yaml: yamlList("b", "a", "z", "b") },
    { op: "remove", params: { path: "list", values: ["b"] }, ...WITHOUT_B },
    { op: "removeValues", params: { path: "list", values: ["b"] }, ...WITHOUT_B },
    { op: "ensureExcludes", params: { path: "list", values: ["b"] }, ...WITHOUT_B },
    { op: "removeValue", params: { path: "list", value: "b" }, ...WITHOUT_B },
    { op: "remove", params: { path: "people", where: { id: 2 } }, ...NO_BOB },
    { op: "removeWhere", params: { path: "people", where: { id: 2 } }, ...NO_BOB },
    { op: "ensureNoItemWhere", params: { path: "people", where: { id: 1 } }, ...NO_ANN },
    { op: "removeAt", params: { path: "list", index: 0 }, jsonc: jsonList("a", "b"), yaml: yamlList("a", "b") },
    { op: "replaceWhere", params: { path: "people", where: { id: 2 }, item: { id: 2, name: "robert" } }, ...ROBERT },
    { op: "updateWhere", params: { path: "people", where: { id: 2 }, value: { name: "robert" } }, ...ROBERT },
    {
        op: "mergeWhere",
        params: { path: "people", where: { id: 1 }, value: { tags: { c: true } } },
        jsonc: jsonPeople('{ "id": 1, "name": "ann", "tags": { "a": true, "c": true } }', BOB, '{ "id": 1, "name": "ann again", "tags": { "c": true } }'),
        yaml: yamlPeople(`${YANN}      c: true\n`, YBOB, `${YANN_AGAIN}    tags:\n      c: true\n`),
    },
    { op: "dedupe", params: { path: "list" }, ...UNIQUE },
    { op: "ensureUnique", params: { path: "list" }, ...UNIQUE },
    { op: "dedupeBy", params: { path: "people", by: "id" }, jsonc: jsonPeople(ANN, BOB), yaml: yamlPeople(YANN, YBOB) },
    { op: "sort", params: { path: "list" }, ...SORTED },
    { op: "ensureSorted", params: { path: "list" }, ...SORTED },
    { op: "sort", params: { path: "list", descending: true }, jsonc: jsonList("b", "b", "a"), yaml: yamlList("b", "b", "a") },
    { op: "sortBy", params: { path: "people", by: "name" }, jsonc: jsonPeople(ANN, ANN_AGAIN, BOB), yaml: yamlPeople(YANN, YANN_AGAIN, YBOB) },
    // Numbers and booleans.
    { op: "increment", params: { path: "count", value: 2 }, jsonc: change(JSONC, ['"count": 1', '"count": 3']), yaml: change(YAML, ["count: 1", "count: 3"]) },
    { op: "decrement", params: { path: "count" }, jsonc: change(JSONC, ['"count": 1', '"count": 0']), yaml: change(YAML, ["count: 1", "count: 0"]) },
    { op: "toggle", params: { path: "flag" }, jsonc: change(JSONC, ['"flag": true', '"flag": false']), yaml: change(YAML, ["flag: true", "flag: false"]) },
    // Text in a string value.
    { op: "appendText", params: { path: "notes", value: " world" }, jsonc: change(JSONC, ['"hello"', '"hello world"']), yaml: change(YAML, ["notes: hello", "notes: hello world"]) },
    { op: "prependText", params: { path: "notes", value: ">> " }, jsonc: change(JSONC, ['"hello"', '">> hello"']), yaml: change(YAML, ["notes: hello", 'notes: ">> hello"']) },
    { op: "replaceText", params: { path: "notes", match: "ell", value: "ELL" }, jsonc: change(JSONC, ['"hello"', '"hELLo"']), yaml: change(YAML, ["notes: hello", "notes: hELLo"]) },
    { op: "replacePattern", params: { path: "notes", match: "l+", value: "L" }, jsonc: change(JSONC, ['"hello"', '"heLo"']), yaml: change(YAML, ["notes: hello", "notes: heLo"]) },
    {
        op: "ensureLine",
        params: { path: "notes", line: "second" },
        jsonc: change(JSONC, ['"hello"', '"hello\\nsecond"']),
        yaml: change(YAML, ["notes: hello", "notes: |-\n  hello\n  second"]),
    },
    { op: "removeLine", params: { path: "notes", line: "hello" }, jsonc: change(JSONC, ['"hello"', '""']), yaml: change(YAML, ["notes: hello", 'notes: ""']) },
    {
        op: "ensureBlock",
        params: { path: "notes", name: "kw", content: "x" },
        jsonc: change(JSONC, ['"hello"', '"hello\\n\\n// >>> sous managed: kw (do not edit between these markers)\\nx\\n// <<< sous managed: kw"']),
        yaml: change(YAML, [
            "notes: hello",
            "notes: |-\n  hello\n\n  # >>> sous managed: kw (do not edit between these markers)\n  x\n  # <<< sous managed: kw",
        ]),
    },
];

/** The text operations on a whole plain text file. */
const TEXT_CASES: Case[] = [
    { op: "ensureLine", params: { line: "gamma", position: { after: "alpha" } }, text: "# notes\nalpha\ngamma\nbeta\n" },
    { op: "removeLine", params: { line: "alpha" }, text: "# notes\nbeta\n" },
    { op: "ensureBlock", params: { name: "kw", content: "one\ntwo" }, text: `${TEXT}\n# >>> sous managed: kw (do not edit between these markers)\none\ntwo\n# <<< sous managed: kw\n` },
    { op: "appendText", params: { value: "tail\n" }, text: `${TEXT}tail\n` },
    { op: "prependText", params: { value: "head\n" }, text: `head\n${TEXT}` },
    { op: "replaceText", params: { match: "alpha", value: "ALPHA" }, text: "# notes\nALPHA\nbeta\n" },
    { op: "replacePattern", params: { match: "/^(\\w+)a$/gm", value: "[$1]" }, text: "# notes\n[alph]\n[bet]\n" },
];

describe("every operation through editor.apply", () => {
    for (const testCase of [...VALUE_CASES, ...TEXT_CASES]) {
        for (const kind of ["jsonc", "yaml", "text"] as const) {
            const expected = testCase[kind];

            if (expected === undefined) continue;

            /**
             * The operation, declared in `editor.edits` and applied by `editor.apply` to a real
             * file: the file becomes exactly the expected text (only what the operation names
             * changes; comments and every other line keep their bytes), a second build changes
             * nothing, and when the entry is no longer declared the file is back byte for byte.
             *
             * set { path: "mode", value: "strict" } on settings.jsonc
             * // -> '"mode": "loose"' becomes '"mode": "strict"'; undeclared -> the original file
             */
            it(`should apply, repeat and undo ${testCase.op} ${JSON.stringify(testCase.params)} in ${kind}`, async () => {
                const [file, original] = FILES[kind];

                await roundTrip(file, original, { file, [testCase.op]: testCase.params }, expected);
            });
        }
    }

    /**
     * Every operation and every other name the package exports has at least one case above.
     *
     * [...OPERATIONS.keys(), ...ALIASES.keys()] -> each found in the cases or the tests below
     */
    it("should cover every operation and every other name", () => {
        const covered = new Set([...VALUE_CASES, ...TEXT_CASES].map((testCase) => testCase.op));

        for (const name of ["ensureFileExists", "createIfMissing", "ensureDirectoryExists"]) covered.add(name);

        // Run through editor.apply in their own files: operations-relocate.spec.ts and operations-comments.spec.ts.
        for (const name of ["copy", "move", "insertBeforeWhere", "insertAfterWhere", "moveItem", "moveItemWhere"]) covered.add(name);
        for (const name of ["setCommentBefore", "setCommentAfter", "removeComment"]) covered.add(name);

        expect([...OPERATIONS.keys(), ...ALIASES.keys()].filter((name) => !covered.has(name))).toEqual([]);
    });
});

describe("files and folders through editor.apply", () => {
    for (const op of ["ensureFileExists", "createIfMissing"]) {
        /**
         * A missing file is created with `content` (a value written in the file's format), an
         * existing one is left exactly as it is, and a file Sous created is removed (after a
         * backup) when nothing declares it any more.
         *
         * createIfMissing { content: { version: 1 } } on missing .kw/descriptor.json
         * // -> '{\n  "version": 1\n}\n'; undeclared -> the file is gone
         */
        it(`should create a missing file with ${op}, leave an existing one, and remove what it created`, async () => {
            const entry = { file: ".kw/descriptor.json", [op]: { content: { version: 1 } } };
            const first = await project.apply([entry]);

            expect(first.result.ok).toBe(true);
            expect(first.warnings).toEqual([]);
            expect(project.read(".kw/descriptor.json")).toBe('{\n  "version": 1\n}\n');

            const second = await project.apply([entry]);

            expect(second.result.files).toEqual([{ file: ".kw/descriptor.json", action: "unchanged" }]);

            await project.apply([]);
            expect(project.read(".kw/descriptor.json")).toBeUndefined();

            project.write("mine.yaml", "# mine\na: 1\n");
            await project.apply([{ file: "mine.yaml", [op]: { content: { other: true } } }]);
            expect(project.read("mine.yaml")).toBe("# mine\na: 1\n");
            await project.apply([]);
            expect(project.read("mine.yaml")).toBe("# mine\na: 1\n");
        });
    }

    /**
     * Folders are created level by level, and a rollback removes the ones Sous created that are
     * still empty; one that was already there stays.
     *
     * ensureDirectoryExists { paths: ["docs/context"] } -> docs/ and docs/context/; undeclared -> both gone
     */
    it("should create folders with ensureDirectoryExists and remove the empty ones it created", async () => {
        fs.mkdirSync(path.join(tmp.path, "kept"));

        const first = await project.apply([{ ensureDirectoryExists: { paths: ["docs/context", "kept"] } }]);

        expect(first.result.ok).toBe(true);
        expect(first.result.assertions.map((outcome) => [outcome.check, outcome.passed])).toEqual([
            ["directoryExists", true],
            ["directoryExists", true],
        ]);
        expect(fs.statSync(path.join(tmp.path, "docs/context")).isDirectory()).toBe(true);

        await project.apply([]);

        expect(fs.existsSync(path.join(tmp.path, "docs"))).toBe(false);
        expect(fs.existsSync(path.join(tmp.path, "kept"))).toBe(true);
    });
});

describe("undoing an order through editor.apply", () => {
    /**
     * A sort records the order the list had before Sous first sorted it, and undoing puts that
     * order back. An item someone added since keeps its place, and the others go back into the
     * places they hold.
     *
     * ["b", "a", "b"]  sort -> ["a", "b", "b"]; someone adds "c" first, the next build sorts it
     * -> ["a", "b", "b", "c"]; undeclared -> ["b", "a", "b", "c"]
     */
    it("should put back a list's order, keeping an item added since in its place", async () => {
        const entry = { file: "settings.yaml", sort: { path: "list" } };

        project.write("settings.yaml", YAML);
        await project.apply([entry]);
        project.write("settings.yaml", yamlList("c", "a", "b", "b"));
        await project.apply([entry]);

        expect(project.read("settings.yaml")).toBe(yamlList("a", "b", "b", "c"));

        await project.apply([]);
        expect(project.read("settings.yaml")).toBe(yamlList("b", "a", "b", "c"));

        const history = JSON.parse(project.read(".sous/sous.edits.json")!);

        expect(history.entries).toEqual([]);
    });

    /**
     * A key order is recorded the same way: `sortKeys` undone puts the keys back in the order they
     * had, and a key added since keeps its place.
     *
     * { x, nested }  sortKeys -> { nested, x }; someone adds "added", the next build sorts it
     * -> { added, nested, x }; undeclared -> { added, x, nested }
     */
    it("should put back an object's key order, keeping a key added since in its place", async () => {
        const entry = { file: "settings.jsonc", sortKeys: { path: "options" } };

        project.write("settings.jsonc", JSONC);
        await project.apply([entry]);
        project.write("settings.jsonc", change(JSONC, [J.options, '"options": { "nested": { "deep": true }, "x": 1, "added": 2 }']));
        await project.apply([entry]);
        await project.apply([]);

        expect(project.read("settings.jsonc")).toBe(change(JSONC, [J.options, '"options": { "added": 2, "x": 1, "nested": { "deep": true } }']));
    });

    /**
     * Removing duplicates records each item removed and where it was; undoing puts them back.
     *
     * ["b", "a", "b"]  dedupe -> ["b", "a"]; undeclared -> ["b", "a", "b"]
     */
    it("should put back the items a deduplication removed", async () => {
        project.write("settings.yaml", YAML);
        await project.apply([{ file: "settings.yaml", dedupe: { path: "list" } }]);

        expect(JSON.parse(project.read(".sous/sous.edits.json")!).entries[0].steps[0].record).toEqual({ removed: [{ index: 2, item: "b" }] });

        await project.apply([]);
        expect(project.read("settings.yaml")).toBe(YAML);
    });
});

/** A YAML file whose keys and items each have comment lines above them, and a blank line between groups. */
const COMMENTED_YAML = `# The first key.
first: 1 # one
# About the middle.
# A second line about it.
middle:
  # about x
  x: 1
  # about y
  y: 2
# The last before the gap.
before: true

# The list.
list:
  # bee
  - b
  # sea
  - c
  # ay
  - a # first
# The last key.
last: end
`;

/** The same as JSONC. */
const COMMENTED_JSONC = `{
    // The first key.
    "first": 1, // one
    // About the middle.
    // A second line about it.
    "middle": {
        // about x
        "x": 1,
        // about y
        "y": 2
    },
    /* The last before the gap. */
    "before": true,

    // The list.
    "list": [
        // bee
        "b",
        // sea
        "c",
        // ay
        "a" // first
    ],
    // The last key.
    "last": "end"
}
`;

const COMMENTED = { yaml: ["c.yaml", COMMENTED_YAML], jsonc: ["c.jsonc", COMMENTED_JSONC] } as const;

/** Each root key's block in the fixtures: its comment lines above and its own lines (JSONC: without its comma, then what follows the comma). */
const BLOCKS = {
    yaml: {
        first: "# The first key.\nfirst: 1 # one",
        middle: "# About the middle.\n# A second line about it.\nmiddle:\n  # about x\n  x: 1\n  # about y\n  y: 2",
        before: "# The last before the gap.\nbefore: true",
        list: "# The list.\nlist:\n  # bee\n  - b\n  # sea\n  - c\n  # ay\n  - a # first",
        last: "# The last key.\nlast: end",
    },
    jsonc: {
        first: ['    // The first key.\n    "first": 1', " // one"],
        middle: ['    // About the middle.\n    // A second line about it.\n    "middle": {\n        // about x\n        "x": 1,\n        // about y\n        "y": 2\n    }', ""],
        before: ['    /* The last before the gap. */\n    "before": true', ""],
        list: ['    // The list.\n    "list": [\n        // bee\n        "b",\n        // sea\n        "c",\n        // ay\n        "a" // first\n    ]', ""],
        last: ['    // The last key.\n    "last": "end"', ""],
    },
} as const;

/**
 * A fixture with its root keys in another order: each key's block in its new place, the blank
 * line still between the third and fourth places, and (JSONC) a comma after all but the last.
 */
function rootInOrder(kind: "yaml" | "jsonc", keys: Array<keyof (typeof BLOCKS)["yaml"]>): string {
    const blocks = keys.map((key, index) => {
        if (kind === "yaml") return BLOCKS.yaml[key];

        const [body, comment] = BLOCKS.jsonc[key];

        return `${body}${index < keys.length - 1 ? "," : ""}${comment}`;
    });
    const joined = [...blocks.slice(0, 3), "", ...blocks.slice(3)].join("\n");

    return kind === "yaml" ? `${joined}\n` : `{\n${joined}\n}\n`;
}
const crlf = (text: string) => text.replace(/\n/g, "\r\n");

describe("keys and items keep their comments through editor.apply", () => {
    /** The expected text for each case: the fixture with a few exact replacements. */
    const cases: Array<{ name: string; op: string; params: JsonObject; yaml: string; jsonc: string }> = [
        {
            name: "a key with a two-line comment, between two commented keys",
            op: "delete",
            params: { path: "middle" },
            yaml: change(COMMENTED_YAML, ["# About the middle.\n# A second line about it.\nmiddle:\n  # about x\n  x: 1\n  # about y\n  y: 2\n", ""]),
            jsonc: change(COMMENTED_JSONC, ['    // About the middle.\n    // A second line about it.\n    "middle": {\n        // about x\n        "x": 1,\n        // about y\n        "y": 2\n    },\n', ""]),
        },
        {
            name: "the first key",
            op: "ensureAbsent",
            params: { path: "first" },
            yaml: change(COMMENTED_YAML, ["# The first key.\nfirst: 1 # one\n", ""]),
            jsonc: change(COMMENTED_JSONC, ['    // The first key.\n    "first": 1, // one\n', ""]),
        },
        {
            name: "the last key",
            op: "deleteIfEquals",
            params: { path: "last", value: "end" },
            yaml: change(COMMENTED_YAML, ["# The last key.\nlast: end\n", ""]),
            jsonc: change(COMMENTED_JSONC, ['    ],\n    // The last key.\n    "last": "end"\n', "    ]\n"]),
        },
        {
            name: "a key of a nested object",
            op: "deleteKeys",
            params: { path: "middle", keys: ["x"] },
            yaml: change(COMMENTED_YAML, ["  # about x\n  x: 1\n", ""]),
            jsonc: change(COMMENTED_JSONC, ['        // about x\n        "x": 1,\n', ""]),
        },
        {
            name: "the keys a keepOnlyKeys drops, either side of a blank line",
            op: "keepOnlyKeys",
            params: { keys: ["first", "middle", "last"] },
            yaml: change(COMMENTED_YAML, ["# The last before the gap.\nbefore: true\n", ""], ["# The list.\nlist:\n  # bee\n  - b\n  # sea\n  - c\n  # ay\n  - a # first\n", ""]),
            jsonc: change(
                COMMENTED_JSONC,
                ['    /* The last before the gap. */\n    "before": true,\n', ""],
                ['    // The list.\n    "list": [\n        // bee\n        "b",\n        // sea\n        "c",\n        // ay\n        "a" // first\n    ],\n', ""],
            ),
        },
        {
            name: "a sorted list whose items each have a comment line above",
            op: "sort",
            params: { path: "list" },
            yaml: change(COMMENTED_YAML, ["  # bee\n  - b\n  # sea\n  - c\n  # ay\n  - a # first\n", "  # ay\n  - a # first\n  # bee\n  - b\n  # sea\n  - c\n"]),
            jsonc: change(COMMENTED_JSONC, [
                '        // bee\n        "b",\n        // sea\n        "c",\n        // ay\n        "a" // first\n',
                '        // ay\n        "a", // first\n        // bee\n        "b",\n        // sea\n        "c"\n',
            ]),
        },
        {
            name: "an item moved first with its comment lines",
            op: "moveItem",
            params: { path: "list", item: "a", position: "first" },
            yaml: change(COMMENTED_YAML, ["  # bee\n  - b\n  # sea\n  - c\n  # ay\n  - a # first\n", "  # ay\n  - a # first\n  # bee\n  - b\n  # sea\n  - c\n"]),
            jsonc: change(COMMENTED_JSONC, [
                '        // bee\n        "b",\n        // sea\n        "c",\n        // ay\n        "a" // first\n',
                '        // ay\n        "a", // first\n        // bee\n        "b",\n        // sea\n        "c"\n',
            ]),
        },
        {
            name: "keys sorted with their comment lines",
            op: "sortKeys",
            params: { path: "middle" },
            yaml: COMMENTED_YAML,
            jsonc: COMMENTED_JSONC,
        },
        {
            name: "a key moved before another with its comment lines",
            op: "moveKeyBefore",
            params: { path: "middle", key: "y", anchor: "x" },
            yaml: change(COMMENTED_YAML, ["  # about x\n  x: 1\n  # about y\n  y: 2\n", "  # about y\n  y: 2\n  # about x\n  x: 1\n"]),
            jsonc: change(COMMENTED_JSONC, ['        // about x\n        "x": 1,\n        // about y\n        "y": 2\n', '        // about y\n        "y": 2,\n        // about x\n        "x": 1\n']),
        },
        {
            name: "a key moved after another with its comment lines",
            op: "moveKeyAfter",
            params: { path: "middle", key: "x", anchor: "y" },
            yaml: change(COMMENTED_YAML, ["  # about x\n  x: 1\n  # about y\n  y: 2\n", "  # about y\n  y: 2\n  # about x\n  x: 1\n"]),
            jsonc: change(COMMENTED_JSONC, ['        // about x\n        "x": 1,\n        // about y\n        "y": 2\n', '        // about y\n        "y": 2,\n        // about x\n        "x": 1\n']),
        },
        {
            name: "a key moved last; the blank line stays between the third and fourth places",
            op: "moveKeyLast",
            params: { key: "before" },
            yaml: rootInOrder("yaml", ["first", "middle", "list", "last", "before"]),
            jsonc: rootInOrder("jsonc", ["first", "middle", "list", "last", "before"]),
        },
        {
            name: "a key moved first; the blank line stays between the third and fourth places",
            op: "moveKeyFirst",
            params: { key: "last" },
            yaml: rootInOrder("yaml", ["last", "first", "middle", "before", "list"]),
            jsonc: rootInOrder("jsonc", ["last", "first", "middle", "before", "list"]),
        },
    ];

    for (const testCase of cases) {
        for (const kind of ["yaml", "jsonc"] as const) {
            /**
             * The key or item takes its comment lines above and the comment on its line with it,
             * blank lines stay where they are, and undoing gives the original file byte for byte,
             * with LF and with CRLF line endings.
             *
             * delete middle -> its two comment lines, its own lines and its keys' comments go;
             * undeclared -> back between "first" and "before", exactly as it was
             */
            it(`should keep the comments of ${testCase.name} (${testCase.op}) in ${kind}`, async () => {
                const [file, original] = COMMENTED[kind];
                const entry = { file, [testCase.op]: testCase.params };

                if (testCase[kind] === original) {
                    // Already in order: nothing to do, and nothing to undo.
                    project.write(file, original);
                    await project.apply([entry]);
                    expect(project.read(file)).toBe(original);

                    return;
                }

                await roundTrip(file, original, entry, testCase[kind]);
                await roundTrip(file, crlf(original), entry, crlf(testCase[kind]));
            });
        }
    }

    /**
     * Sorting keys that each have comment lines, out of order, then undoing.
     *
     * { y (# about y), x (# about x) }  sortKeys -> { x, y } with their comments; undone -> as before
     */
    it("should sort keys with their comment lines and put them back", async () => {
        const yaml = "opts:\n  # about y\n  y: 2 # two\n\n  # about x\n  x: 1\n";

        await roundTrip("s.yaml", yaml, { file: "s.yaml", sortKeys: { path: "opts" } }, "opts:\n  # about x\n  x: 1\n\n  # about y\n  y: 2 # two\n");

        const jsonc = '{\n  // about y\n  "y": 2, // two\n\n  // about x\n  "x": 1\n}\n';

        await roundTrip("s.jsonc", jsonc, { file: "s.jsonc", sortKeys: {} }, '{\n  // about x\n  "x": 1,\n\n  // about y\n  "y": 2 // two\n}\n');
    });

    /**
     * A key alone between two blank lines leaves both when deleted, and undoing puts it back
     * between them: blank lines belong to the places between keys, never to a key.
     *
     * "a: 1\n\n# about b\nb: 2\n\nc: 3\n"  delete b -> "a: 1\n\n\nc: 3\n"; undeclared -> the original
     */
    it("should leave the blank lines around a deleted key and put it back between them", async () => {
        await roundTrip("s.yaml", "a: 1\n\n# about b\nb: 2\n\nc: 3\n", { file: "s.yaml", delete: { path: "b" } }, "a: 1\n\n\nc: 3\n");
        await roundTrip("s.jsonc", '{\n  "a": 1,\n\n  // about b\n  "b": 2,\n\n  "c": 3\n}\n', { file: "s.jsonc", delete: { path: "b" } }, '{\n  "a": 1,\n\n\n  "c": 3\n}\n');
    });
});

describe("undoing replacePattern through editor.apply", () => {
    /**
     * A replacement cannot be worked backwards, so undoing puts back the text from before Sous's
     * last replacement, and only while the text is still what Sous left; someone's later change
     * is kept.
     *
     * "alpha" replacePattern a$ -> "alphA"; someone writes "alphA!" -> undeclared: "alphA!" stays
     */
    it("should put back the text it replaced only while it is what Sous left", async () => {
        const entry = { file: "notes.txt", replacePattern: { match: "a$", value: "A" } };

        project.write("notes.txt", "alpha");
        await project.apply([entry]);
        expect(project.read("notes.txt")).toBe("alphA");

        project.write("notes.txt", "alphA!");
        await project.apply([entry]);
        await project.apply([]);
        expect(project.read("notes.txt")).toBe("alphA!");

        project.write("notes.txt", "beta");
        await project.apply([entry]);
        project.write("notes.txt", "betA, gamma");
        await project.apply([entry]);
        expect(project.read("notes.txt")).toBe("betA, gammA");

        await project.apply([]);
        expect(project.read("notes.txt")).toBe("betA, gamma");
    });
});

describe("undoing removeLine through editor.apply", () => {
    /**
     * A text emptied by removeLine cannot tell whether it ended in a line break, so the record
     * says; undoing puts back exactly the text there was, with or without one.
     *
     * "only"   removeLine "only" -> ""; undeclared -> "only"
     * "only\n" removeLine "only" -> ""; undeclared -> "only\n"
     */
    it("should put back the last line with or without its line break", async () => {
        for (const original of ["only", "only\n", "a\r\nonly"]) {
            const entry = { file: "notes.txt", removeLine: { line: "only" } };

            project.write("notes.txt", original);
            await project.apply([entry]);
            await project.apply([]);

            expect(project.read("notes.txt")).toBe(original);
        }
    });
});

describe("actions through editor.apply", () => {
    /**
     * An action acts once per declaration: the same entry declared twice acts twice, a later
     * build acts no more, and each declaration that goes undoes its own.
     *
     * insertBefore { before: "a", item: "z" } declared twice -> ["b", "z", "z", "a", "b"]
     */
    it("should act once per declaration, and undo each declaration's own", async () => {
        const entry = { file: "settings.jsonc", insertBefore: { path: "list", before: "a", item: "z" } };

        project.write("settings.jsonc", JSONC);
        await project.apply([entry, entry]);
        await project.apply([entry, entry]);

        expect(project.read("settings.jsonc")).toBe(jsonList("b", "z", "z", "a", "b"));

        await project.apply([entry]);
        expect(project.read("settings.jsonc")).toBe(jsonList("b", "z", "a", "b"));

        await project.apply([]);
        expect(project.read("settings.jsonc")).toBe(JSONC);
    });
});
