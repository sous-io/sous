import { describe, it, expect } from "vitest";
import {
  declarationFor,
  describeDeclaration,
  describeDependencyKind,
  indexDependencyLists,
} from "./declarations.js";

describe("declarationFor()", () => {
  /**
   * A recipe named on its own is brought in by that entry, with the kind of
   * the list it sits in.
   *
   * declarationFor({ depends: ["workflow/a@^1"] }, "workflow/a")
   * // -> { declared: "workflow/a@^1", kind: "depends" }
   */
  it("should answer with the entry naming the recipe", () => {
    expect(declarationFor({ depends: ["workflow/a@^1"] }, "workflow/a")).toEqual({
      declared: "workflow/a@^1",
      kind: "depends",
    });
  });

  /**
   * A recipe covered only by a namespace entry is brought in by that entry.
   *
   * declarationFor({ subscribes: ["workflow"] }, "workflow/a")
   * // -> { declared: "workflow", kind: "subscribes" }
   */
  it("should answer with the namespace entry covering the recipe", () => {
    expect(declarationFor({ subscribes: ["workflow"] }, "workflow/a")).toEqual({
      declared: "workflow",
      kind: "subscribes",
    });
  });

  /**
   * An entry naming the recipe wins over a namespace covering it, and any
   * co-subscription covering it makes it a co-subscription.
   *
   * declarationFor({ depends: ["workflow/a"], subscribes: ["workflow"] }, "workflow/a")
   * // -> { declared: "workflow/a", kind: "subscribes" }
   */
  it("should prefer the named entry and let a co-subscription decide the kind", () => {
    expect(
      declarationFor({ depends: ["workflow/a"], subscribes: ["workflow"] }, "workflow/a")
    ).toEqual({ declared: "workflow/a", kind: "subscribes" });
  });

  /**
   * A locator names a recipe in another repository by its last two segments.
   *
   * declarationFor({ depends: ["github://org/repo/review/wording@^1.0"] }, "review/wording")
   * // -> { declared: "github://org/repo/review/wording@^1.0", kind: "depends" }
   */
  it("should match a locator by the recipe it names", () => {
    const written = "github://org/repo/review/wording@^1.0";
    expect(declarationFor({ depends: [written] }, "review/wording")).toEqual({
      declared: written,
      kind: "depends",
    });
  });

  /**
   * A recipe no entry covers has no declaration, and an entry that does not
   * parse covers nothing.
   *
   * declarationFor({ depends: ["tools", "not a ref!"] }, "workflow/a") // -> undefined
   */
  it("should answer undefined when nothing covers the recipe", () => {
    expect(declarationFor({ depends: ["tools", "not a ref!"] }, "workflow/a")).toBeUndefined();
  });
});

describe("indexDependencyLists()", () => {
  /**
   * The recorded declarations stand for the manifest's lists, each entry once.
   *
   * indexDependencyLists({ "workflow/a": { declared: "workflow", kind: "subscribes" },
   *   "workflow/b": { declared: "workflow", kind: "subscribes" },
   *   "tools/c": { declared: "tools/c", kind: "depends" } })
   * // -> { depends: ["tools/c"], subscribes: ["workflow"] }
   */
  it("should rebuild the lists from what each dependency records", () => {
    expect(
      indexDependencyLists({
        "workflow/a": { version: "1.0.0", declared: "workflow", kind: "subscribes" },
        "workflow/b": { version: "1.0.0", declared: "workflow", kind: "subscribes" },
        "tools/c": { version: "2.0.0", declared: "tools/c", kind: "depends" },
      })
    ).toEqual({ depends: ["tools/c"], subscribes: ["workflow"] });
  });

  /**
   * A version recorded as depending on nothing stands for two empty lists.
   *
   * indexDependencyLists({}) // -> { depends: [], subscribes: [] }
   */
  it("should read an empty record as depending on nothing", () => {
    expect(indexDependencyLists({})).toEqual({ depends: [], subscribes: [] });
  });

  /**
   * An entry that records no dependencies, or records them without saying how
   * they were declared, cannot stand for the manifest's lists.
   *
   * indexDependencyLists(undefined)                               // -> undefined
   * indexDependencyLists({ "workflow/a": { version: "1.0.0" } })  // -> undefined
   */
  it("should answer undefined when the entry does not record declarations", () => {
    expect(indexDependencyLists(undefined)).toBeUndefined();
    expect(indexDependencyLists({ "workflow/a": { version: "1.0.0" } })).toBeUndefined();
  });
});

describe("describeDeclaration()", () => {
  /**
   * A namespace entry is named as a whole namespace; anything else is shown as
   * written.
   *
   * describeDeclaration("workflow")           // -> "the whole 'workflow' namespace"
   * describeDeclaration("workflow/a@^1.0")    // -> "workflow/a@^1.0"
   */
  it("should name a whole namespace and show anything else as written", () => {
    expect(describeDeclaration("workflow")).toBe("the whole 'workflow' namespace");
    expect(describeDeclaration("workflow/a@^1.0")).toBe("workflow/a@^1.0");
    expect(describeDeclaration("not a ref!")).toBe("not a ref!");
  });
});

describe("describeDependencyKind()", () => {
  /**
   * Each kind reads as what it does for the project.
   *
   * describeDependencyKind("subscribes") // -> "co-subscription"
   */
  it("should word each kind plainly", () => {
    expect(describeDependencyKind("subscribes")).toBe("co-subscription");
    expect(describeDependencyKind("depends")).toBe("build dependency");
    expect(describeDependencyKind(undefined)).toBe("not recorded");
  });
});
