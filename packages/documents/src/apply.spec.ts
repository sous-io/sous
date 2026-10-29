import { describe, expect, it } from "vitest";
import { applyPatch, applyPatches } from "./apply.js";
import { deepFreeze } from "./json.js";
import type { JsonValue, Patch, PatchProblem } from "./types.js";

/** Applies patches and collects the problems. */
function run(root: JsonValue | undefined, patches: Patch[]): { value: JsonValue | undefined; problems: string[] } {
    const problems: PatchProblem[] = [];
    const value = applyPatches(root, patches, { onProblem: (problem) => problems.push(problem) });

    return { value, problems: problems.map((problem) => problem.message) };
}

describe("applyPatch()", () => {
    describe("setKey", () => {
        /**
         * setKey should set one key, creating the missing objects along the path.
         *
         * applyPatch({}, { op: "setKey", path: "compilation", key: "overwriteUntracked", value: false });
         * // -> { compilation: { overwriteUntracked: false } }
         */
        it("should set a key and create missing objects", () => {
            expect(applyPatch({}, { op: "setKey", path: "compilation", key: "overwriteUntracked", value: false }))
                .toEqual({ compilation: { overwriteUntracked: false } });
            expect(applyPatch(undefined, { op: "setKey", path: "a.b", key: "c", value: 1 })).toEqual({ a: { b: { c: 1 } } });
            expect(applyPatch({ a: 1 }, { op: "setKey", path: "", key: "a", value: 2 })).toEqual({ a: 2 });
        });

        /**
         * setKey should report a path through a value that is not an object, and change nothing.
         *
         * applyPatch({ a: "s" }, { op: "setKey", path: "a", key: "b", value: 1 });
         * // problem: a is a string, not an object, so setKey cannot set "b" on it.
         */
        it("should report type conflicts", () => {
            const root = { a: "s", list: [1], n: null };

            expect(run(root, [{ op: "setKey", path: "a", key: "b", value: 1 }]))
                .toEqual({ value: root, problems: ['a is a string, not an object, so setKey cannot set "b" on it.'] });
            expect(run(root, [{ op: "setKey", path: "a.x", key: "b", value: 1 }]).problems)
                .toEqual(['a is a string, not an object, so it has no key "x".']);
            expect(run(root, [{ op: "setKey", path: "list", key: "b", value: 1 }]).problems)
                .toEqual(['list is an array, not an object, so setKey cannot set "b" on it.']);
            expect(run(root, [{ op: "setKey", path: "n", key: "b", value: 1 }]).problems)
                .toEqual(['n is null, not an object, so setKey cannot set "b" on it.']);
            expect(run([1], [{ op: "setKey", path: "", key: "b", value: 1 }]).problems)
                .toEqual(['The root is an array, not an object, so setKey cannot set "b" on it.']);
            expect(run(root, [{ op: "setKey", path: "nothing[0]", key: "b", value: 1 }]).problems)
                .toEqual(["nothing is missing, so it has no item 0."]);
            expect(run({ o: {} }, [{ op: "setKey", path: "o.list[2]", key: "b", value: 1 }]).problems)
                .toEqual(["o.list is missing, so it has no item 2."]);
            expect(run({ a: {} }, [{ op: "setKey", path: "a[0]", key: "b", value: 1 }]).problems)
                .toEqual(["a is an object, not an array, so it has no item 0."]);
            expect(run({ a: [] }, [{ op: "setKey", path: "a[0]", key: "b", value: 1 }]).problems)
                .toEqual(["a has 0 items, so there is no item 0."]);
        });

        /**
         * setKey should set a key named __proto__ as an ordinary own key.
         */
        it("should never touch the prototype", () => {
            const result = applyPatch({}, { op: "setKey", path: "", key: "__proto__", value: { polluted: true } }) as object;

            expect(Object.hasOwn(result, "__proto__")).toBe(true);
            expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        });
    });

    describe("deleteKey", () => {
        /**
         * deleteKey should delete one key, and do nothing for a missing key or path.
         *
         * applyPatch({ tools: { codex: {}, claude: {} } }, { op: "deleteKey", path: "tools", key: "codex" });
         * // -> { tools: { claude: {} } }
         */
        it("should delete a key, and ignore missing ones", () => {
            expect(applyPatch({ tools: { codex: {}, claude: {} } }, { op: "deleteKey", path: "tools", key: "codex" }))
                .toEqual({ tools: { claude: {} } });

            const root = { tools: {}, list: [1] };

            expect(run(root, [
                { op: "deleteKey", path: "tools", key: "codex" },
                { op: "deleteKey", path: "nothing.deeper", key: "codex" },
                { op: "deleteKey", path: "list[5]", key: "x" },
            ])).toEqual({ value: root, problems: [] });
            expect(run(undefined, [{ op: "deleteKey", path: "", key: "a" }])).toEqual({ value: undefined, problems: [] });
        });
    });

    describe("renameKey", () => {
        /**
         * renameKey should rename a key in place, replacing an existing key with the new name.
         *
         * applyPatch({ a: 1, codex: 2, z: 3 }, { op: "renameKey", path: "", key: "codex", to: "openai" });
         * // -> { a: 1, openai: 2, z: 3 }   (key order kept)
         */
        it("should rename keeping the key's place", () => {
            const result = applyPatch({ a: 1, codex: 2, z: 3 }, { op: "renameKey", path: "", key: "codex", to: "openai" });

            expect(Object.keys(result as object)).toEqual(["a", "openai", "z"]);
            expect(applyPatch({ a: 1, b: 2 }, { op: "renameKey", path: "", key: "a", to: "b" })).toEqual({ b: 1 });
            expect(applyPatch({ a: 1 }, { op: "renameKey", path: "", key: "a", to: "a" })).toEqual({ a: 1 });
        });

        /**
         * renameKey should report a missing key.
         */
        it("should report a missing key", () => {
            expect(run({ tools: {} }, [{ op: "renameKey", path: "tools", key: "codex", to: "x" }]).problems)
                .toEqual(['tools has no key "codex" to rename.']);
            expect(run({}, [{ op: "renameKey", path: "missing", key: "codex", to: "x" }]).problems)
                .toEqual([`missing has no key "codex" to rename.`]);
            expect(run({}, [{ op: "renameKey", path: "a.b", key: "codex", to: "x" }]).problems)
                .toEqual(["a.b is missing."]);
        });
    });

    describe("setIndex", () => {
        /**
         * setIndex should set one item, and report an index out of range.
         *
         * applyPatch({ list: [1, 2] }, { op: "setIndex", path: "list", index: 1, value: 9 });
         * // -> { list: [1, 9] }
         */
        it("should set an item and report bad indexes", () => {
            expect(applyPatch({ list: [1, 2] }, { op: "setIndex", path: "list", index: 1, value: 9 })).toEqual({ list: [1, 9] });
            expect(run({ list: [1, 2, 3] }, [{ op: "setIndex", path: "list", index: 7, value: 9 }]).problems)
                .toEqual(["list has 3 items, so there is no item 7 to set."]);
            expect(run({ list: {} }, [{ op: "setIndex", path: "list", index: 0, value: 9 }]).problems)
                .toEqual(["list is an object, not an array, so there is no item 0 to set."]);
            expect(run({}, [{ op: "setIndex", path: "list", index: 0, value: 9 }]).problems)
                .toEqual(["list is missing, so there is no item 0 to set."]);
        });
    });

    describe("insertAt", () => {
        /**
         * insertAt should insert at an index, append at "end", and create a missing array.
         *
         * applyPatches(undefined, [
         *     { op: "insertAt", path: "targets", index: "end", value: "a" },
         *     { op: "insertAt", path: "targets", index: 0, value: "b" },
         * ]);
         * // -> { targets: ["b", "a"] }
         */
        it("should insert, append and create arrays", () => {
            expect(applyPatches(undefined, [
                { op: "insertAt", path: "targets", index: "end", value: "a" },
                { op: "insertAt", path: "targets", index: 0, value: "b" },
                { op: "insertAt", path: "targets", index: 2, value: "c" },
                { op: "insertAt", path: "a.deep", index: 0, value: 1 },
            ])).toEqual({ targets: ["b", "a", "c"], a: { deep: [1] } });
            expect(applyPatch(undefined, { op: "insertAt", path: "", index: "end", value: 1 })).toEqual([1]);
        });

        /**
         * insertAt should report an index past the end, and an index into a missing array other
         * than 0 or "end".
         *
         * applyPatch({ list: [1, 2, 3] }, { op: "insertAt", path: "list", index: 7, value: 0 });
         * // problem: list has 3 items, so an item cannot be inserted at 7.
         */
        it("should report bad indexes", () => {
            expect(run({ list: [1, 2, 3] }, [{ op: "insertAt", path: "list", index: 7, value: 0 }]).problems)
                .toEqual(["list has 3 items, so an item cannot be inserted at 7."]);
            expect(run({}, [{ op: "insertAt", path: "list", index: 2, value: 0 }]).problems)
                .toEqual(["list is missing, so an item cannot be inserted at 2."]);
            expect(run({}, [{ op: "insertAt", path: "a.list", index: 2, value: 0 }]).problems)
                .toEqual(["a.list is missing, so an item cannot be inserted at 2."]);
            expect(run({ list: "s" }, [{ op: "insertAt", path: "list", index: 0, value: 0 }]).problems)
                .toEqual(["list is a string, not an array, so insertAt cannot insert into it."]);
            expect(run({ list: [1] }, [{ op: "insertAt", path: "list", index: -1, value: 0 }]).problems)
                .toEqual(["list has 1 item, so an item cannot be inserted at -1."]);
        });
    });

    describe("removeIndex", () => {
        /**
         * removeIndex should remove one item, and report what is missing (S2: "removeIndex 7
         * removes whatever is at index 7 at that point").
         *
         * applyPatch({ list: [1, 2, 3] }, { op: "removeIndex", path: "list", index: 0 });
         * // -> { list: [2, 3] }
         */
        it("should remove an item and report bad indexes", () => {
            expect(applyPatch({ list: [1, 2, 3] }, { op: "removeIndex", path: "list", index: 0 })).toEqual({ list: [2, 3] });
            expect(run({ list: [1, 2, 3] }, [{ op: "removeIndex", path: "list", index: 7 }]).problems)
                .toEqual(["list has 3 items, so there is no item 7 to remove."]);
            expect(run({ list: true }, [{ op: "removeIndex", path: "list", index: 0 }]).problems)
                .toEqual(["list is a boolean, not an array, so there is no item 0 to remove."]);
        });
    });

    /**
     * applyPatches should change nothing it was given, even when the input is deeply frozen.
     *
     * const input = deepFreeze({ a: { list: [1] } });
     * applyPatches(input, [...]);   // input is unchanged; no error is thrown
     */
    it("should never change its input, even a frozen one", () => {
        const input = deepFreeze({ a: { list: [1, { x: 1 }] }, b: { keep: true } });
        const result = applyPatches(input, [
            { op: "insertAt", path: "a.list", index: "end", value: 2 },
            { op: "setKey", path: "a.list[1]", key: "x", value: 2 },
            { op: "renameKey", path: "", key: "b", to: "c" },
        ]) as Record<string, unknown>;

        expect(input).toEqual({ a: { list: [1, { x: 1 }] }, b: { keep: true } });
        expect(result).toEqual({ a: { list: [1, { x: 2 }, 2] }, c: { keep: true } });
    });

    /**
     * applyPatches should share untouched branches with the input (copy on write), and copy a
     * container only once per call however many patches change it.
     */
    it("should copy only the containers it changes", () => {
        const input = { touched: { a: 1 }, untouched: { b: 2 } };
        const result = applyPatches(input, [
            { op: "setKey", path: "touched", key: "x", value: 1 },
            { op: "setKey", path: "touched", key: "y", value: 2 },
        ]) as typeof input & { touched: Record<string, number> };

        expect(result.untouched).toBe(input.untouched);
        expect(result.touched).toEqual({ a: 1, x: 1, y: 2 });
    });

    /**
     * applyPatches should not change a value inserted by an earlier patch when a later patch
     * edits inside it.
     */
    it("should copy an inserted value before editing inside it", () => {
        const value = { x: 1 };
        const result = applyPatches({}, [
            { op: "setKey", path: "", key: "a", value },
            { op: "setKey", path: "a", key: "y", value: 2 },
        ]);

        expect(value).toEqual({ x: 1 });
        expect(result).toEqual({ a: { x: 1, y: 2 } });
    });

    /**
     * applyPatches should call onApplied for each applied patch and onProblem for each skipped
     * one, and keep going after a problem.
     */
    it("should report applied patches and keep going after problems", () => {
        const applied: string[] = [];
        const problems: string[] = [];
        const result = applyPatches({ list: [] }, [
            { op: "removeIndex", path: "list", index: 0 },
            { op: "insertAt", path: "list", index: "end", value: 1 },
        ], {
            onApplied: (patch) => applied.push(patch.op),
            onProblem: (problem) => problems.push(problem.patch.op),
        });

        expect(result).toEqual({ list: [1] });
        expect(applied).toEqual(["insertAt"]);
        expect(problems).toEqual(["removeIndex"]);
        expect(applyPatch({ list: [] }, { op: "removeIndex", path: "list", index: 0 })).toEqual({ list: [] });
    });

    /**
     * applyPatches should report any patch on a root that is not a container.
     */
    it("should report patches on a scalar root", () => {
        expect(run("text", [{ op: "setKey", path: "", key: "a", value: 1 }]).problems)
            .toEqual(['The root is a string, not an object, so setKey cannot set "a" on it.']);
    });
});
