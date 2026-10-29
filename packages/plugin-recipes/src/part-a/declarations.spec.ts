import { describe, expect, it } from "vitest";
import { shortRefs } from "../../test/part-a/helpers.js";
import { Declarations, describeDeclaration } from "./declarations.js";

const refs = shortRefs();
const declarations = new Declarations(() => refs.resolver, () => refs.format);

describe("recipes.declarations", () => {
    /** `of` lists `subscribes` first, each with the ref it parses to. */
    it("should list every declaration", () => {
        const found = declarations.of({ depends: ["tools/helper@^1"], subscribes: ["workflow"] });

        expect(found.map((entry) => [entry.declared, entry.kind, entry.named])).toEqual([
            ["workflow", "subscribes", false],
            ["tools/helper@^1", "depends", true],
        ]);
    });

    /** An entry naming the recipe wins over a namespace entry; any co-subscription makes the kind `subscribes`. */
    it("should settle which entry covers a recipe", () => {
        const source = { depends: ["workflow/a"], subscribes: ["workflow"] };

        expect(declarations.covering(source, "workflow/a")).toMatchObject({ declared: "workflow/a", kind: "subscribes", named: true });
        expect(declarations.covering(source, "workflow/b")).toMatchObject({ declared: "workflow", kind: "subscribes", named: false });
        expect(declarations.covering(source, "other/c")).toBeUndefined();
    });

    /** Between two entries naming the recipe, the later list's wins. */
    it("should prefer the later named entry", () => {
        expect(declarations.covering({ depends: ["workflow/a@^1"], subscribes: ["workflow/a"] }, "workflow/a")?.declared).toBe("workflow/a");
    });

    /** A whole namespace reads as one; anything else as written. */
    it("should describe a declaration", () => {
        const [namespace, recipe] = declarations.of({ subscribes: ["workflow"], depends: ["tools/x"] });

        expect(describeDeclaration(namespace!)).toBe("the whole 'workflow' namespace");
        expect(describeDeclaration(recipe!)).toBe("tools/x");
    });
});
