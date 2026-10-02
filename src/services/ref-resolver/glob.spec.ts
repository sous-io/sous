import { describe, expect, it } from "vitest";
import { hasGlob, isGlobName, matchName, matchNames, splitSegments } from "./glob.js";

describe("hasGlob() and isGlobName()", () => {
  /**
   * hasGlob should see every glob character; isGlobName should also require
   * that the pattern could stand for a name.
   *
   * hasGlob("a*") // -> true; isGlobName("a b*") // -> false
   */
  it("should recognize glob syntax", () => {
    for (const text of ["*", "a?", "[ab]", "{a,b}", "**"]) expect(hasGlob(text)).toBe(true);
    expect(hasGlob("plain-name")).toBe(false);
    expect(isGlobName("work*")).toBe(true);
    expect(isGlobName("a b*")).toBe(false);
    expect(isGlobName("plain")).toBe(false);
  });
});

describe("splitSegments()", () => {
  /**
   * splitSegments should split at slashes outside braces only.
   *
   * splitSegments("a/{b/c,d}/e") // -> ["a", "{b/c,d}", "e"]
   */
  it("should keep brace groups whole", () => {
    expect(splitSegments("a/{b/c,d}/e")).toEqual(["a", "{b/c,d}", "e"]);
    expect(splitSegments("a//b")).toEqual(["a", "", "b"]);
  });
});

describe("matchName() and matchNames()", () => {
  /**
   * The exact spelling is "exact", a spelling that differs only in case is
   * "folded", and anything else matches nothing.
   *
   * matchName("Workflow", "workflow") // -> "folded"
   */
  it("should tell an exact match from a case-insensitive one", () => {
    expect(matchName("workflow", "workflow")).toBe("exact");
    expect(matchName("Workflow", "workflow")).toBe("folded");
    expect(matchName("nothing", "workflow")).toBeUndefined();
  });

  /**
   * A glob matches with minimatch, exactly first and ignoring case second.
   *
   * matchName("work*", "workflow") // -> "exact"
   */
  it("should match glob patterns", () => {
    expect(matchName("work*", "workflow")).toBe("exact");
    expect(matchName("WORK*", "workflow")).toBe("folded");
    expect(matchName("{a,b}", "b")).toBe("exact");
    expect(matchName("x*", "workflow")).toBeUndefined();
  });

  /**
   * matchNames should return the exact matches, and only without any the
   * ones that differ in case.
   *
   * matchNames("workflow", ["workflow", "Workflow"]) // -> ["workflow"]
   */
  it("should prefer exact matches over case-insensitive ones", () => {
    expect(matchNames("Workflow", ["workflow", "tooling"])).toEqual(["workflow"]);
    expect(matchNames("workflow", ["workflow", "Workflow"])).toEqual(["workflow"]);
    expect(matchNames("WORKFLOW", ["workflow", "Workflow"])).toEqual(["workflow", "Workflow"]);
    expect(matchNames("nothing", ["workflow"])).toEqual([]);
  });
});
