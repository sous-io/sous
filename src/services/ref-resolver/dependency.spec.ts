import { describe, expect, it } from "vitest";
import { settleDependency } from "./dependency.js";
import { formatRef } from "./format.js";
import { locationOf } from "./parts.js";
import { isConfirmedByRecord } from "./lookups/recorded-dependency-lookup.js";
import { RefSource } from "./source.js";
import { sharedRefResolver } from "./container.js";

/** Every reading of a dependency as a manifest may write it. */
const readings = (written: string) => sharedRefResolver().parse(written, RefSource.Manifest).refs;

describe("isConfirmedByRecord()", () => {
  const nested = readings("https://gitlab.com/a/b/c/d");

  /**
   * A record under a reading's key, carrying its repository, confirms it.
   *
   * isConfirmedByRecord(a/b naming c/d, { "c/d": { repo: "gitlab.com/a/b" } }) // -> true
   */
  it("should confirm the recipe reading an index recorded", () => {
    const confirmed = nested.filter((ref) =>
      isConfirmedByRecord(ref, { "c/d": { repo: "gitlab.com/a/b" } })
    );
    expect(confirmed.map((ref) => formatRef(ref))).toEqual(["gitlab://a/b/-/c/d"]);
  });

  /**
   * A namespace reading is confirmed by a record for any recipe inside it.
   *
   * isConfirmedByRecord(a/b/c naming d, { "d/x": { repo: "gitlab.com/a/b/c" } }) // -> true
   */
  it("should confirm the namespace reading by a recipe recorded inside it", () => {
    const confirmed = nested.filter((ref) =>
      isConfirmedByRecord(ref, { "d/x": { repo: "gitlab.com/a/b/c" } })
    );
    expect(confirmed.map((ref) => formatRef(ref))).toEqual(["gitlab://a/b/c/-/d"]);
  });

  /**
   * Nothing recorded confirms nothing.
   *
   * isConfirmedByRecord(reading, undefined) // -> false
   */
  it("should confirm nothing without a record", () => {
    expect(nested.some((ref) => isConfirmedByRecord(ref, undefined))).toBe(false);
    expect(nested.some((ref) => isConfirmedByRecord(ref, { "c/d": { repo: "elsewhere" } }))).toBe(
      false
    );
  });
});

describe("settleDependency()", () => {
  /**
   * A dependency that reads one way settles to that reading.
   *
   * settleDependency("github://o/r/workflow/alpha") // -> that reading
   */
  it("should settle a dependency that reads one way", () => {
    expect(formatRef(settleDependency("github://o/r/workflow/alpha")!)).toBe(
      "github://o/r/workflow/alpha"
    );
    expect(formatRef(settleDependency("workflow/alpha")!)).toBe("workflow/alpha");
  });

  /**
   * A dependency that reads several ways settles through the index's record,
   * then through what is known locally, and otherwise not at all.
   *
   * settleDependency("gitlab://a/b/c/d", { recorded: { "c/d": { repo: "gitlab.com/a/b" } } })
   */
  it("should settle several readings through the record or what is known", () => {
    expect(
      formatRef(
        settleDependency("gitlab://a/b/c/d", { recorded: { "c/d": { repo: "gitlab.com/a/b" } } })!
      )
    ).toBe("gitlab://a/b/-/c/d");
    expect(
      formatRef(
        settleDependency("gitlab://a/b/c/d", {
          known: (reading) => locationOf(reading)?.identity === "gitlab.com/a/b/c",
        })!
      )
    ).toBe("gitlab://a/b/c/-/d");
    expect(settleDependency("gitlab://a/b/c/d", { known: () => true })).toBeUndefined();
    expect(settleDependency("gitlab://a/b/c/d")).toBeUndefined();
  });

  /**
   * A dependency a manifest may not write that way raises the refusal.
   *
   * settleDependency("sous-recipes:workflow/alpha") // throws
   */
  it("should raise the refusal for a form a manifest does not allow", () => {
    expect(() => settleDependency("sous-recipes:workflow/alpha")).toThrow(/repo:/);
  });
});
