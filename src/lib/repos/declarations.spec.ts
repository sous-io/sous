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
   * A version entry that records the manifest's lists stands for them, and a
   * list it leaves out is empty.
   *
   * indexDependencyLists({ subscribes: ["workflow", "github://o/r/tools"] })
   * // -> { depends: [], subscribes: ["workflow", "github://o/r/tools"] }
   */
  it("should answer with the lists the entry records", () => {
    expect(
      indexDependencyLists({ depends: ["tools/c"], subscribes: ["workflow"] })
    ).toEqual({ depends: ["tools/c"], subscribes: ["workflow"] });
    expect(indexDependencyLists({ subscribes: ["github://o/r/tools"] })).toEqual({
      depends: [],
      subscribes: ["github://o/r/tools"],
    });
  });

  /**
   * An entry recorded before the index described recipes records neither list,
   * and cannot stand for the manifest.
   *
   * indexDependencyLists({}) // -> undefined
   */
  it("should answer undefined when the entry records neither list", () => {
    expect(indexDependencyLists({})).toBeUndefined();
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
