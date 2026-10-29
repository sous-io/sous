import { describe, expect, it } from "vitest";
import { describePatch, describePatchSet } from "./describe.js";
import { createDocument } from "./value-document.js";

describe("describePatch()", () => {
    /**
     * describePatch should name the operation and the place it acts on.
     *
     * describePatch({ op: "removeIndex", path: "compilation.targets", index: 7 });
     * // -> "removeIndex compilation.targets[7]"
     */
    it("should describe every primitive", () => {
        expect(describePatch({ op: "removeIndex", path: "compilation.targets", index: 7 })).toBe("removeIndex compilation.targets[7]");
        expect(describePatch({ op: "setKey", path: "compilation", key: "overwriteUntracked", value: false })).toBe("setKey compilation.overwriteUntracked");
        expect(describePatch({ op: "deleteKey", path: "tools", key: "codex" })).toBe("deleteKey tools.codex");
        expect(describePatch({ op: "renameKey", path: "tools", key: "codex", to: "openai" })).toBe("renameKey tools.codex → tools.openai");
        expect(describePatch({ op: "insertAt", path: "compilation.targets", index: "end", value: 1 })).toBe("insertAt compilation.targets[end]");
        expect(describePatch({ op: "insertAt", path: "compilation.targets", index: 0, value: 1 })).toBe("insertAt compilation.targets[0]");
        expect(describePatch({ op: "setIndex", path: "l", index: 2, value: 1 })).toBe("setIndex l[2]");
    });
});

describe("describePatchSet()", () => {
    /**
     * describePatchSet should list a contributor's helpers and the primitives each made, as
     * `--layers` shows them (C78, S2 example).
     *
     * confd/620-no-diagrams.js
     *   removeWhere compilation.targets
     *     removeIndex compilation.targets[7]
     */
    it("should show helpers and their primitives (C78)", () => {
        const targets = ["a", "b", "c", "d", "e", "f", "g", "diagrams"].map((id) => ({ id }));
        const doc = createDocument({ compilation: { targets } });

        doc.atPath("compilation.targets").removeWhere((target) => target.id === "diagrams");
        doc.atPath("tools.codex").delete();

        const set = { ...doc.patches(), name: "confd/620-no-diagrams.js" };

        expect(describePatchSet(set)).toBe([
            "confd/620-no-diagrams.js",
            "  removeWhere compilation.targets",
            "    removeIndex compilation.targets[7]",
            "  deleteKey tools.codex",
        ].join("\n"));
        expect(describePatchSet({ name: "x", path: "", patches: [] }, 4)).toBe("    x");
    });
});
