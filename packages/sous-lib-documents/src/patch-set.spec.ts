import { describe, expect, it } from "vitest";
import { countPatches, flattenPatchSet, isPatch, isPatchSet, PatchRecorder } from "./patch-set.js";
import type { Patch, PatchSet } from "./types.js";

const p1: Patch = { op: "setKey", path: "a", key: "b", value: 1 };
const p2: Patch = { op: "removeIndex", path: "list", index: 7 };
const p3: Patch = { op: "insertAt", path: "list", index: "end", value: 1 };

describe("isPatch()", () => {
    /**
     * isPatch should be true only for objects with a known op.
     *
     * isPatch({ op: "deleteKey", path: "tools", key: "codex" });   // -> true
     */
    it("should recognize primitives", () => {
        expect(isPatch(p1)).toBe(true);
        expect(isPatch({ op: "move" })).toBe(false);
        expect(isPatch(null)).toBe(false);
        expect(isPatch("setKey")).toBe(false);
    });
});

describe("isPatchSet()", () => {
    /**
     * isPatchSet should be true for a name and a patches array, with no op.
     *
     * isPatchSet({ name: "merge", patches: [] });   // -> true
     */
    it("should recognize patch sets", () => {
        expect(isPatchSet({ name: "merge", patches: [] })).toBe(true);
        expect(isPatchSet({ name: "merge", patches: [], op: "setKey" })).toBe(false);
        expect(isPatchSet({ name: "merge" })).toBe(false);
        expect(isPatchSet({ patches: [] })).toBe(false);
        expect(isPatchSet(undefined)).toBe(false);
    });
});

describe("flattenPatchSet()", () => {
    /**
     * flattenPatchSet should list every primitive in order, however deeply nested.
     *
     * flattenPatchSet({ name: "c", patches: [p1, { name: "merge", patches: [p2, p3] }] });
     * // -> [p1, p2, p3]
     */
    it("should flatten nested sets in order", () => {
        const set: PatchSet = { name: "c", patches: [p1, { name: "merge", patches: [p2, { name: "x", patches: [p3] }] }] };

        expect(flattenPatchSet(set)).toEqual([p1, p2, p3]);
        expect(countPatches(set)).toBe(3);
    });
});

describe("PatchRecorder", () => {
    /**
     * PatchRecorder should nest each helper's primitives in a named set inside its parent.
     *
     * recorder.open("removeWhere", "compilation.targets"); recorder.add(p2); recorder.close();
     * // -> { name: "diagrams", patches: [{ name: "removeWhere", path: "compilation.targets", patches: [p2] }] }
     */
    it("should record nested sets", () => {
        const recorder = new PatchRecorder("diagrams");

        expect(recorder.isEmpty()).toBe(true);
        recorder.add(p1);
        recorder.open("removeWhere", "compilation.targets");
        recorder.add(p2);
        recorder.open("inner");
        recorder.add(p3);
        recorder.close();
        recorder.close();

        expect(recorder.result()).toEqual({
            name: "diagrams",
            patches: [p1, { name: "removeWhere", path: "compilation.targets", patches: [p2, { name: "inner", patches: [p3] }] }],
        });
        expect(recorder.isEmpty()).toBe(false);
    });

    /**
     * PatchRecorder should drop a helper set that recorded nothing.
     */
    it("should drop empty sets", () => {
        const recorder = new PatchRecorder("c");

        recorder.open("removeWhere", "list");
        recorder.close();
        expect(recorder.result()).toEqual({ name: "c", patches: [] });
    });

    /**
     * PatchRecorder should refuse to close more sets than were opened.
     */
    it("should throw when closing with nothing open", () => {
        expect(() => new PatchRecorder("c").close()).toThrow("no patch set open");
    });
});
