import { describe, expect, it } from "vitest";
import { applyPatches } from "./apply.js";
import { flattenPatchSet } from "./patch-set.js";
import { deserializePatchSet, parsePatch, parsePatchFile, PatchFormatError, serializePatchSet } from "./serialize.js";
import { createDocument } from "./value-document.js";
import type { PatchSet } from "./types.js";

describe("serializePatchSet()", () => {
    /**
     * Any patch set should serialize to JSON and back unchanged, so it can be saved, sent,
     * previewed and applied later.
     *
     * deserializePatchSet(serializePatchSet(set));   // deeply equal to set
     */
    it("should round-trip a contributor's patch set through JSON", () => {
        const doc = createDocument({ compilation: { targets: [{ id: "a" }, { id: "diagrams" }] } });

        doc.atPath("compilation.targets").removeWhere((target) => target.id === "diagrams");
        doc.root().merge({ _vars: { machineRole: "laptop" } });
        doc.atPath("tools.codex").set({ command: "codex" });

        const set = doc.patches();
        const text = serializePatchSet(set);
        const back = deserializePatchSet(text);

        expect(back).toEqual(set);
        expect(applyPatches({ compilation: { targets: [{ id: "a" }, { id: "diagrams" }] } }, flattenPatchSet(back))).toEqual(doc.value());
    });
});

describe("deserializePatchSet()", () => {
    /**
     * deserializePatchSet should accept parsed data too, and normalize paths to canonical strings.
     */
    it("should accept data and normalize paths", () => {
        const set = deserializePatchSet({
            name: "preview",
            path: ["a", "b.c"],
            patches: [{ op: "setKey", path: ["subscriptions", "workflow/x"], key: "enabled", value: false }],
        });

        expect(set).toEqual({
            name: "preview",
            path: 'a."b.c"',
            patches: [{ op: "setKey", path: 'subscriptions."workflow/x"', key: "enabled", value: false }],
        });
    });

    /**
     * deserializePatchSet should name what is wrong with malformed data.
     *
     * deserializePatchSet("{");   // throws PatchFormatError: The patch set is not valid JSON ...
     */
    it("should reject malformed sets", () => {
        expect(() => deserializePatchSet("{")).toThrow(PatchFormatError);
        expect(() => deserializePatchSet("{")).toThrow("not valid JSON");
        expect(() => deserializePatchSet("[]")).toThrow('must be an object with "name" and "patches"');
        expect(() => deserializePatchSet({ patches: [] })).toThrow('needs a "name" string');
        expect(() => deserializePatchSet({ name: "x" })).toThrow('(x) needs a "patches" array');
        expect(() => deserializePatchSet({ name: "x", patches: [{ name: "inner" }] })).toThrow('Item 1 of x (inner) needs a "patches" array');
        expect(() => deserializePatchSet({ name: "x", patches: [{ op: "nope" }] })).toThrow('Item 1 of x: "op" must be one of');
        expect(() => deserializePatchSet({ name: "x", path: 5, patches: [] })).toThrow('"path" must be a string');
    });
});

describe("parsePatch()", () => {
    /**
     * parsePatch should check each primitive's fields and return a clean copy.
     *
     * parsePatch({ op: "setKey", path: ["_vars"], key: "machineRole", value: "laptop" });
     * // -> { op: "setKey", path: "_vars", key: "machineRole", value: "laptop" }
     */
    it("should accept every primitive", () => {
        expect(parsePatch({ op: "setKey", path: ["_vars"], key: "machineRole", value: "laptop", extra: 1 }))
            .toEqual({ op: "setKey", path: "_vars", key: "machineRole", value: "laptop" });
        expect(parsePatch({ op: "deleteKey", path: "tools", key: "codex" })).toEqual({ op: "deleteKey", path: "tools", key: "codex" });
        expect(parsePatch({ op: "renameKey", key: "a", to: "b" })).toEqual({ op: "renameKey", path: "", key: "a", to: "b" });
        expect(parsePatch({ op: "setIndex", path: "l", index: 0, value: null })).toEqual({ op: "setIndex", path: "l", index: 0, value: null });
        expect(parsePatch({ op: "insertAt", path: "l", index: "end", value: 1 })).toEqual({ op: "insertAt", path: "l", index: "end", value: 1 });
        expect(parsePatch({ op: "removeIndex", path: "l", index: 7 })).toEqual({ op: "removeIndex", path: "l", index: 7 });
    });

    /**
     * parsePatch should say which field is wrong.
     *
     * parsePatch({ op: "removeIndex", path: "l", index: -1 });
     * // throws: The patch: removeIndex needs "index" to be a whole number of 0 or more.
     */
    it("should reject bad fields", () => {
        expect(() => parsePatch(null)).toThrow('must be an object with an "op"');
        expect(() => parsePatch({})).toThrow('got null');
        expect(() => parsePatch({ op: "setKey", path: "a" })).toThrow('setKey needs "key" to be a string');
        expect(() => parsePatch({ op: "setKey", path: "a", key: "b" })).toThrow('setKey needs a "value"');
        expect(() => parsePatch({ op: "renameKey", key: "a" })).toThrow('needs "to" to be a string');
        expect(() => parsePatch({ op: "removeIndex", path: "l", index: -1 })).toThrow("whole number of 0 or more.");
        expect(() => parsePatch({ op: "insertAt", path: "l", index: 1.5, value: 1 })).toThrow('or "end"');
        expect(() => parsePatch({ op: "setIndex", path: "l", index: "end", value: 1 })).toThrow("whole number");
        expect(() => parsePatch({ op: "deleteKey", path: "a..b", key: "x" })).toThrow("empty key");
    });
});

describe("parsePatchFile()", () => {
    /**
     * A .patch.json file with a single `$patches` key should hold several patches.
     */
    it("should read several patches under $patches", () => {
        const text = `// .sous/conf.d/720-my-special-thing.patch.json: several patches, so a single $patches key
{
    "$patches": [
        { "op": "setKey", "path": "compilation", "key": "overwriteUntracked", "value": false },
        { "op": "deleteKey", "path": "tools", "key": "codex" }
    ]
}
`;

        expect(parsePatchFile(text, "json", "confd/720-my-special-thing.patch.json")).toEqual({
            name: "confd/720-my-special-thing.patch.json",
            patches: [
                { op: "setKey", path: "compilation", key: "overwriteUntracked", value: false },
                { op: "deleteKey", path: "tools", key: "codex" },
            ],
        });
    });

    /**
     * A .patch.json file without `$patches` should hold one patch.
     */
    it("should read one patch", () => {
        const text = '{ "op": "setKey", "path": "_vars", "key": "machineRole", "value": "laptop" }';
        const set: PatchSet = parsePatchFile(text, "json", "confd/722-one-thing.patch.json");

        expect(set.patches).toEqual([{ op: "setKey", path: "_vars", key: "machineRole", value: "laptop" }]);
    });

    /**
     * A .patch.jsonl file should hold one patch per line, skipping blank and `//` lines.
     */
    it("should read one patch per line", () => {
        const text = `// .sous/conf.d/721-my-list-of-things.patch.jsonl: one patch per line
{"op": "insertAt", "path": "compilation.targets", "index": 0, "value": {"id": "first", "entryPoint": "a.tpl.md"}}

{"op": "setKey", "path": "_vars", "key": "machineRole", "value": "laptop"}\r
`;

        expect(parsePatchFile(text, "jsonl", "confd/721.patch.jsonl").patches).toEqual([
            { op: "insertAt", path: "compilation.targets", index: 0, value: { id: "first", entryPoint: "a.tpl.md" } },
            { op: "setKey", path: "_vars", key: "machineRole", value: "laptop" },
        ]);
    });

    /**
     * Errors should name the file and the line or patch that is wrong.
     */
    it("should name the file and line in errors", () => {
        expect(() => parsePatchFile("{", "json", "x.patch.json")).toThrow("x.patch.json is not valid JSON.");
        expect(() => parsePatchFile("", "json", "x.patch.json")).toThrow("x.patch.json is not valid JSON.");
        expect(() => parsePatchFile('{"$patches": 1}', "json", "x.patch.json")).toThrow('x.patch.json: "$patches" must be an array');
        expect(() => parsePatchFile('{"$patches": [{"op": "x"}]}', "json", "x.patch.json")).toThrow("Patch 1 in x.patch.json");
        expect(() => parsePatchFile('{"op": "x"}', "json", "x.patch.json")).toThrow("The patch in x.patch.json");
        expect(() => parsePatchFile('\n{"op":', "jsonl", "y.patch.jsonl")).toThrow("Line 2 of y.patch.jsonl is not valid JSON.");
        expect(() => parsePatchFile('{"op": "deleteKey"}', "jsonl", "y.patch.jsonl")).toThrow("Line 1 of y.patch.jsonl");
    });
});
