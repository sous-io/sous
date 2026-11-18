import { describe, expect, it } from "vitest";
import { deepFreeze } from "./json.js";
import { createDocument, ValueDocument } from "./value-document.js";
import type { PatchSet } from "./types.js";

describe("createDocument()", () => {
    /**
     * createDocument should start from a plain copy of the value, or `{}`.
     *
     * createDocument().value();   // -> {}
     */
    it("should start from a copy or an empty object", () => {
        const input = { a: 1 };
        const doc = createDocument(input);

        doc.atPath("a").set(2);
        expect(input).toEqual({ a: 1 });
        expect(createDocument().value()).toEqual({});
        expect(createDocument(() => 0).value()).toEqual({});
    });
});

describe("ValueDocument", () => {
    /**
     * A ValueDocument should edit a frozen value without changing or tripping over it.
     */
    it("should work on frozen values", () => {
        const frozen = deepFreeze({ list: [1], nested: { a: 1 } });
        const doc = new ValueDocument(frozen);

        doc.atPath("list").append(2);
        doc.atPath("nested.a").set(2);
        expect(doc.value()).toEqual({ list: [1, 2], nested: { a: 2 } });
        expect(frozen).toEqual({ list: [1], nested: { a: 1 } });
    });

    /**
     * apply should replay a patch set made elsewhere, keeping its nesting in patches(), and
     * return the patches that could not apply.
     *
     * doc.apply({ name: "preview", patches: [...] });   // -> [] when every patch applied
     */
    it("should apply patch sets made elsewhere and report problems", () => {
        const doc = createDocument({ list: [1] });
        const set: PatchSet = {
            name: "preview",
            patches: [
                { op: "insertAt", path: "list", index: "end", value: 2 },
                { name: "removeWhere", path: "list", patches: [{ op: "removeIndex", path: "list", index: 9 }] },
            ],
        };
        const problems = doc.apply(set);

        expect(doc.value()).toEqual({ list: [1, 2] });
        expect(problems.map((problem) => problem.message)).toEqual(["list has 2 items, so there is no item 9 to remove."]);
        expect(doc.problems()).toHaveLength(1);
        expect(doc.patches()).toEqual({ name: "document", patches: [set] });
        expect(doc.apply({ op: "setKey", path: "", key: "b", value: true })).toEqual([]);
    });
});
