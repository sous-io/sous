import { describe, expect, it } from "vitest";
import { DocNode } from "./node.js";
import { flattenPatchSet } from "./patch-set.js";
import { createDocument } from "./value-document.js";
import type { DocumentBackend, JsonValue, PathSegment } from "./types.js";

/** A backend that records every read, as the config builder does. */
function recordingDoc(value: JsonValue) {
    const doc = createDocument(value);
    const reads: string[] = [];
    const inner = doc.root() as unknown as { backend: DocumentBackend };
    const backend: DocumentBackend = {
        read: (path: readonly PathSegment[]) => {
            reads.push(path.join("."));

            return inner.backend.read(path);
        },
        emit: (patch) => inner.backend.emit(patch),
        openSet: (name, path) => inner.backend.openSet(name, path),
        closeSet: () => inner.backend.closeSet(),
    };

    return { doc, reads, node: (path: PathSegment[] = []) => new DocNode(backend, path) };
}

const targets = () => ({
    compilation: {
        targets: [
            { id: "a" }, { id: "b" }, { id: "c" }, { id: "d" },
            { id: "e" }, { id: "f" }, { id: "g" }, { id: "diagrams" },
        ],
    },
});

describe("DocNode", () => {
    describe("navigation", () => {
        /**
         * A node should know its path, and give nodes below and above it.
         *
         * doc.atPath("compilation").atPath("targets").atIndex(7).pathString;
         * // -> "compilation.targets[7]"
         */
        it("should navigate by path, index and parent", () => {
            const doc = createDocument(targets());
            const node = doc.atPath("compilation").atPath("targets").atIndex(7);

            expect(node.path).toEqual(["compilation", "targets", 7]);
            expect(node.pathString).toBe("compilation.targets[7]");
            expect(node.parent().pathString).toBe("compilation.targets");
            expect(doc.root().parent().pathString).toBe("");
            expect(Object.isFrozen(node.path)).toBe(true);
        });
    });

    describe("inspecting", () => {
        /**
         * The inspecting methods should describe the value at the node, and treat a missing value
         * plainly: exists() false, type() "missing", keys() [], length() 0.
         *
         * doc.atPath("tools").keys();   // -> ["claude", "codex"]
         */
        it("should inspect values", () => {
            const doc = createDocument({ tools: { claude: {}, codex: {} }, list: [1, 2], n: 3 });

            expect(doc.atPath("tools").exists()).toBe(true);
            expect(doc.atPath("tools").type()).toBe("object");
            expect(doc.atPath("tools").isObject()).toBe(true);
            expect(doc.atPath("tools").isArray()).toBe(false);
            expect(doc.atPath("tools").keys()).toEqual(["claude", "codex"]);
            expect(doc.atPath("list").isArray()).toBe(true);
            expect(doc.atPath("list").length()).toBe(2);
            expect(doc.atPath("list").get()).toEqual([1, 2]);
            expect(doc.atPath("n").get<number>()).toBe(3);
            expect(doc.atPath("n").keys()).toEqual([]);
            expect(doc.atPath("n").length()).toBe(0);
            expect(doc.atPath("nope").exists()).toBe(false);
            expect(doc.atPath("nope").type()).toBe("missing");
            expect(doc.atPath("nope").get()).toBeUndefined();
            expect(doc.atPath("nope").valueOr(true)).toBe(true);
            expect(doc.atPath("n").valueOr(0)).toBe(3);
        });

        /**
         * Inspecting methods should read through the backend, so the config builder can record them.
         */
        it("should read through the backend", () => {
            const { node, reads } = recordingDoc({ a: 1 });

            node(["a"]).exists();
            node(["a"]).valueOr(0);
            expect(reads).toEqual(["a", "a"]);
        });
    });

    describe("objects and values", () => {
        /**
         * set should emit one setKey (or setIndex for an array item) and never read.
         *
         * doc.atPath("compilation.includeSourceComments").set(true);
         * // patch: { op: "setKey", path: "compilation", key: "includeSourceComments", value: true }
         */
        it("should set values with one primitive and no read", () => {
            const { doc, node, reads } = recordingDoc({ list: [1, 2] });

            node(["compilation", "includeSourceComments"]).set(true);
            node(["list", 1]).setValue(9);
            expect(reads).toEqual([]);
            expect(doc.patches().patches).toEqual([
                { op: "setKey", path: "compilation", key: "includeSourceComments", value: true },
                { op: "setIndex", path: "list", index: 1, value: 9 },
            ]);
            expect(doc.value()).toEqual({ list: [1, 9], compilation: { includeSourceComments: true } });
        });

        /**
         * set should make values plain JSON first, and treat undefined as delete.
         *
         * node.set({ at: new Date(), re: /x/ });   // stored as { re: "/x/" }
         */
        it("should make values plain and delete on undefined", () => {
            const doc = createDocument({ a: 1, list: [1, 2] });

            doc.atPath("b").set({ at: new Date(), re: /x/ });
            doc.atPath("a").set(undefined);
            doc.atPath("list[0]").delete();
            expect(doc.value()).toEqual({ b: { re: "/x/" }, list: [2] });
        });

        /**
         * delete should emit deleteKey for a key and removeIndex for an item; delete at the root
         * empties the document.
         */
        it("should delete keys, items and the root", () => {
            const doc = createDocument({ a: 1, b: 2 });

            doc.atPath("a").delete();
            expect(doc.patches().patches).toEqual([{ op: "deleteKey", path: "", key: "a" }]);
            doc.root().delete();
            expect(doc.value()).toEqual({});

            const list = createDocument([1, 2]);

            list.root().delete();
            expect(list.value()).toEqual([]);
        });

        /**
         * rename should emit one renameKey; an array item cannot be renamed.
         *
         * doc.atPath("tools.codex").rename("openai");
         * // patch: { op: "renameKey", path: "tools", key: "codex", to: "openai" }
         */
        it("should rename keys", () => {
            const doc = createDocument({ tools: { codex: {} }, list: [1] });

            doc.atPath("tools.codex").rename("openai");
            expect(doc.patches().patches).toEqual([{ op: "renameKey", path: "tools", key: "codex", to: "openai" }]);
            expect(() => doc.atPath("list[0]").rename("x")).toThrow("array item");
        });

        /**
         * merge should change key by key, join arrays by appending each item, and keep every key
         * the data does not name, emitting leaf-level primitives in one "merge" set.
         *
         * // { compilation: { targets: [a], keep: 1 } } merged with { compilation: { targets: [b], x: true } }
         * // -> { compilation: { targets: [a, b], keep: 1, x: true } }
         */
        it("should merge key by key and join arrays", () => {
            const doc = createDocument({ compilation: { targets: ["a"], keep: 1, scalar: 1 }, list: "s" });

            doc.root().merge({
                compilation: { targets: ["b"], x: true, nested: { deep: 1 }, empty: {}, emptyList: [], scalar: { now: "object" } },
                list: [1],
                fresh: { a: [1], b: {} },
                dropped: undefined,
            });

            expect(doc.value()).toEqual({
                compilation: { targets: ["a", "b"], keep: 1, x: true, nested: { deep: 1 }, empty: {}, emptyList: [], scalar: { now: "object" } },
                list: [1],
                fresh: { a: [1], b: {} },
            });

            const merge = doc.patches().patches[0] as { name: string; patches: unknown[] };

            expect(merge.name).toBe("merge");
            expect(flattenPatchSet(doc.patches())).toContainEqual({ op: "insertAt", path: "compilation.targets", index: "end", value: "b" });
            expect(flattenPatchSet(doc.patches())).toContainEqual({ op: "setKey", path: "compilation.nested", key: "deep", value: 1 });
        });

        /**
         * merge should keep an existing empty object or array as it is when merging an empty one.
         */
        it("should leave existing containers alone for empty data", () => {
            const doc = createDocument({ a: { x: 1 }, b: [1] });

            doc.root().merge({ a: {}, b: [] });
            expect(doc.value()).toEqual({ a: { x: 1 }, b: [1] });
            expect(doc.patches().patches).toEqual([]);
        });

        /**
         * merge should replace a value that is not an object, and do nothing for undefined.
         */
        it("should set non-object data whole", () => {
            const doc = createDocument({ a: [1], b: { c: 1 } });

            doc.atPath("a").merge({ x: 1 });
            doc.atPath("b").merge(5);
            doc.atPath("b").merge(undefined);
            expect(doc.value()).toEqual({ a: { x: 1 }, b: 5 });
        });

        /**
         * merge at the root should read the root, so the builder monitors the whole config.
         */
        it("should read the node it merges into", () => {
            const { node, reads } = recordingDoc({});

            node().merge({ a: 1 });
            expect(reads).toEqual([""]);
        });

        /**
         * replace should set a value whole; at the root it deletes what the new value lacks and
         * sets the rest.
         *
         * // root { a: 1, b: 2 } replaced by { b: 3, c: 4 } -> deleteKey a, setKey b, setKey c
         */
        it("should replace values whole", () => {
            const doc = createDocument({ a: 1, b: 2, sub: { x: 1, y: 2 } });

            doc.atPath("sub").replace({ z: 1 });
            expect(doc.value()).toEqual({ a: 1, b: 2, sub: { z: 1 } });
            doc.root().replace({ b: 3, c: 4 });
            expect(doc.value()).toEqual({ b: 3, c: 4 });
            doc.root().set({ only: true });
            expect(doc.value()).toEqual({ only: true });
            doc.atPath("only").replace(undefined);
            expect(doc.value()).toEqual({});
            doc.root().replace(undefined);
            expect(doc.value()).toEqual({});
        });

        /**
         * replace at the root should refuse a value of another kind than the root's.
         */
        it("should refuse to replace the root with another kind", () => {
            expect(() => createDocument({}).root().replace([1])).toThrow("cannot be replaced");
            expect(() => createDocument({}).root().replace("s")).toThrow("object or an array");

            const list = createDocument([1]);

            expect(() => list.root().replace({ a: 1 })).toThrow("root is an array");
            list.root().replace([2, 3]);
            expect(list.value()).toEqual([2, 3]);
        });
    });

    describe("arrays", () => {
        /**
         * append, prepend and insertAt should each emit one insertAt and never read; append uses
         * "end", so it never depends on the array's length.
         *
         * doc.atPath("compilation.targets").appendValue({ id: "diagrams" });
         * // patch: { op: "insertAt", path: "compilation.targets", index: "end", value: { id: "diagrams" } }
         */
        it("should insert items without reading", () => {
            const { doc, node, reads } = recordingDoc({});
            const list = node(["compilation", "targets"]);

            list.appendValue({ id: "diagrams" });
            list.prependValue("first");
            list.append(undefined);
            list.insertAt(1, "second");
            list.prepend("zero");
            list.removeAt(0);
            expect(reads).toEqual([]);
            expect(doc.patches().patches[0]).toEqual({ op: "insertAt", path: "compilation.targets", index: "end", value: { id: "diagrams" } });
            expect(doc.value()).toEqual({ compilation: { targets: ["first", "second", { id: "diagrams" }] } });
        });

        /**
         * removeWhere should emit one removeIndex per match, highest index first, in a
         * "removeWhere" set (the example).
         *
         * config.atPath("compilation.targets").removeWhere((target) => target.id === "diagrams");
         * // -> { "op": "removeIndex", "path": "compilation.targets", "index": 7 }
         */
        it("should remove matches highest index first (the example)", () => {
            const doc = createDocument(targets());

            doc.atPath("compilation.targets").removeWhere((target) => target.id === "diagrams");
            expect(doc.patches().patches).toEqual([{
                name: "removeWhere",
                path: "compilation.targets",
                patches: [{ op: "removeIndex", path: "compilation.targets", index: 7 }],
            }]);

            const many = createDocument({ list: [1, 2, 3, 4] });

            many.atPath("list").removeWhere((item: number) => item % 2 === 0);
            expect(flattenPatchSet(many.patches()).map((patch) => (patch as { index: number }).index)).toEqual([3, 1]);
            expect(many.value()).toEqual({ list: [1, 3] });
        });

        /**
         * removeWhere on something that is not an array should do nothing.
         */
        it("should do nothing on a missing array", () => {
            const doc = createDocument({});

            doc.atPath("list").removeWhere(() => true);
            expect(doc.patches().patches).toEqual([]);
        });

        /**
         * upsertWhere should replace the first match with setIndex, or append when nothing
         * matches; an undefined item removes the match.
         *
         * node.upsertWhere((t) => t.id === "b", { id: "b", v: 2 });   // setIndex 1
         */
        it("should upsert", () => {
            const doc = createDocument({ list: [{ id: "a" }, { id: "b" }] });
            const list = doc.atPath("list");

            list.upsertWhere((item) => item.id === "b", { id: "b", v: 2 });
            list.upsertWhere((item) => item.id === "c", { id: "c" });
            list.upsertWhere((item) => item.id === "a", undefined);
            list.upsertWhere((item) => item.id === "zzz", undefined);
            expect(doc.value()).toEqual({ list: [{ id: "b", v: 2 }, { id: "c" }] });
            expect(flattenPatchSet(doc.patches()).map((patch) => patch.op)).toEqual(["setIndex", "insertAt", "removeIndex"]);
        });

        /**
         * findWhere should give a node for the first match, to edit in place, or undefined.
         *
         * doc.atPath("list").findWhere((t) => t.id === "b")?.atPath("enabled").set(false);
         */
        it("should find a match to edit in place", () => {
            const doc = createDocument({ list: [{ id: "a" }, { id: "b" }] });
            const found = doc.atPath("list").findWhere((item) => item.id === "b");

            expect(found?.pathString).toBe("list[1]");
            found?.atPath("enabled").set(false);
            expect(doc.value()).toEqual({ list: [{ id: "a" }, { id: "b", enabled: false }] });
            expect(doc.atPath("list").findWhere(() => false)).toBeUndefined();
        });

        /**
         * move should emit a removeIndex then an insertAt, ending with the item at `to`.
         *
         * // [a, b, c].move(0, 2) -> [b, c, a]
         */
        it("should move items", () => {
            const doc = createDocument({ list: ["a", "b", "c"] });

            doc.atPath("list").move(0, 2);
            expect(doc.value()).toEqual({ list: ["b", "c", "a"] });
            doc.atPath("list").move(2, 0);
            expect(doc.value()).toEqual({ list: ["a", "b", "c"] });
            doc.atPath("list").move(5, 0);
            doc.atPath("list").move(1, 1);
            expect(doc.value()).toEqual({ list: ["a", "b", "c"] });
            expect(flattenPatchSet(doc.patches())).toHaveLength(4);
        });

        /**
         * dedupe should keep the first of each repeated item, by value or by a key function.
         *
         * // [1, 2, 1, 3, 2].dedupe() -> [1, 2, 3]
         */
        it("should remove repeated items", () => {
            const doc = createDocument({ list: [1, 2, 1, 3, 2], objects: [{ id: "a", v: 1 }, { id: "a", v: 2 }, { v: 3, id: "b" }] });

            doc.atPath("list").dedupe();
            doc.atPath("objects").dedupe((item) => (item as { id: string }).id);
            expect(doc.value()).toEqual({ list: [1, 2, 3], objects: [{ id: "a", v: 1 }, { v: 3, id: "b" }] });
        });
    });

    describe("patchSet()", () => {
        /**
         * patchSet should let a plugin write its own helper on the primitives: what it emits is
         * grouped in a set with the helper's name and the node's path.
         *
         * node.patchSet("appendUnique", (n) => { if (!n.valueOr([]).includes("x")) n.append("x"); });
         */
        it("should group a custom helper's primitives", () => {
            const doc = createDocument({ list: ["x"] });
            const appendUnique = (value: string) => (node: DocNode) => {
                if (!node.valueOr<string[]>([]).includes(value)) {
                    node.append(value);
                }
            };

            doc.atPath("list").patchSet("appendUnique", appendUnique("x"));
            doc.atPath("list").patchSet("appendUnique", appendUnique("y"));
            expect(doc.patches().patches).toEqual([{
                name: "appendUnique",
                path: "list",
                patches: [{ op: "insertAt", path: "list", index: "end", value: "y" }],
            }]);
        });

        /**
         * patchSet should close its set even when the helper throws.
         */
        it("should close the set when the helper throws", () => {
            const doc = createDocument({});

            expect(() => doc.atPath("a").patchSet("boom", (node) => {
                node.set(1);
                throw new Error("boom");
            })).toThrow("boom");
            doc.atPath("b").set(2);
            expect(doc.patches().patches).toEqual([
                { name: "boom", path: "a", patches: [{ op: "setKey", path: "", key: "a", value: 1 }] },
                { op: "setKey", path: "", key: "b", value: 2 },
            ]);
        });
    });
});
