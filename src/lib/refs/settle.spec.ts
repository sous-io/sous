import { describe, expect, it } from "vitest";
import { formatRef, parseRef, type RefReading } from "./parse.js";
import {
  confirmedReadings,
  matchNames,
  settleBrowsed,
  settleDependency,
  settleInIndex,
  type SettleIndex,
} from "./settle.js";

/** An index publishing two namespaces, with recipes in the usual folders. */
const INDEX: SettleIndex = {
  namespaces: ["workflow", "tooling"],
  recipes: {
    "workflow/alpha": { path: "recipes/workflow/alpha" },
    "workflow/beta": { path: "recipes/workflow/beta" },
    "tooling/lint": { path: "packages/lint" },
  },
};

/** The canonical form of every settled reading. */
function settled(readings: RefReading[]): string[] {
  return readings.map((reading) => formatRef(reading));
}

describe("matchNames()", () => {
  /**
   * The exact spelling wins; only when it matches nothing is case ignored.
   *
   * matchNames("Workflow", ["workflow"]) // -> ["workflow"]
   * matchNames("workflow", ["workflow", "Workflow"]) // -> ["workflow"]
   */
  it("should match exactly first, then ignoring case", () => {
    expect(matchNames("Workflow", ["workflow", "tooling"])).toEqual(["workflow"]);
    expect(matchNames("workflow", ["workflow", "Workflow"])).toEqual(["workflow"]);
    expect(matchNames("WORKFLOW", ["workflow", "Workflow"])).toEqual(["workflow", "Workflow"]);
    expect(matchNames("nothing", ["workflow"])).toEqual([]);
  });
});

describe("settleInIndex()", () => {
  /**
   * A named reading settles to the index's own spelling, keeping its location
   * and range.
   *
   * settleInIndex(parseRef("github://o/r/Workflow/Alpha@^1")[0], INDEX)
   * // -> [github://o/r/workflow/alpha@^1]
   */
  it("should settle a named reading to the index's spelling", () => {
    const [reading] = parseRef("github://o/r/Workflow/Alpha@^1") as [RefReading];
    expect(settled(settleInIndex(reading, INDEX))).toEqual(["github://o/r/workflow/alpha@^1"]);
    const [namespace] = parseRef("WORKFLOW") as [RefReading];
    expect(settled(settleInIndex(namespace, INDEX))).toEqual(["workflow"]);
  });

  /**
   * A reading the index does not publish settles to nothing, and so does a
   * whole repository.
   *
   * settleInIndex(parseRef("workflow/gamma")[0], INDEX) // -> []
   */
  it("should settle to nothing when the index does not publish it", () => {
    expect(settleInIndex(parseRef("workflow/gamma")[0]!, INDEX)).toEqual([]);
    expect(settleInIndex(parseRef("https://github.com/o/r")[0]!, INDEX)).toEqual([]);
  });

  /**
   * A browsed reading settles through the recipe folders.
   *
   * settleInIndex(parseRef("https://github.com/o/r/tree/main/packages/lint")[0], INDEX)
   * // -> [github://o/r/tooling/lint]
   */
  it("should settle a browsed reading through the recipe folders", () => {
    const [reading] = parseRef("https://github.com/o/r/tree/main/packages/lint") as [RefReading];
    expect(settled(settleInIndex(reading, INDEX))).toEqual(["github://o/r/tooling/lint"]);
  });
});

describe("settleBrowsed()", () => {
  /**
   * A recipe's folder names that recipe, whatever the branch is called, even
   * one holding slashes.
   *
   * settleBrowsed("feature/x/recipes/workflow/alpha", INDEX) // -> [workflow/alpha]
   */
  it("should settle a recipe folder behind any branch", () => {
    expect(settled(settleBrowsed("main/recipes/workflow/alpha", INDEX))).toEqual([
      "workflow/alpha",
    ]);
    expect(settled(settleBrowsed("feature/x/recipes/workflow/alpha", INDEX))).toEqual([
      "workflow/alpha",
    ]);
  });

  /**
   * A file inside a recipe's folder names that recipe.
   *
   * settleBrowsed("main/recipes/workflow/beta/skills/SKILL.md", INDEX) // -> [workflow/beta]
   */
  it("should settle a file inside a recipe folder", () => {
    expect(settled(settleBrowsed("main/recipes/workflow/beta/skills/SKILL.md", INDEX))).toEqual([
      "workflow/beta",
    ]);
  });

  /**
   * A folder holding the recipes of one namespace names that namespace.
   *
   * settleBrowsed("main/recipes/workflow", INDEX) // -> [workflow]
   */
  it("should settle a folder above one namespace's recipes to the namespace", () => {
    expect(settled(settleBrowsed("main/recipes/workflow", INDEX))).toEqual(["workflow"]);
  });

  /**
   * A folder holding several namespaces, or no recipe at all, names nothing.
   *
   * settleBrowsed("main/docs", INDEX) // -> []
   */
  it("should settle nothing for a folder that is no recipe or namespace", () => {
    expect(settleBrowsed("main/docs", INDEX)).toEqual([]);
    expect(
      settleBrowsed("main/all", {
        namespaces: ["a", "b"],
        recipes: { "a/x": { path: "all/a/x" }, "b/y": { path: "all/b/y" } },
      })
    ).toEqual([]);
  });

  /**
   * The deepest recipe wins when one recipe's folder sits inside another's.
   *
   * settleBrowsed("main/outer/inner", { "a/outer": "outer", "a/inner": "outer/inner" }) // -> [a/inner]
   */
  it("should prefer the deepest recipe folder", () => {
    expect(
      settled(
        settleBrowsed("main/outer/inner", {
          namespaces: ["a"],
          recipes: { "a/outer": { path: "outer" }, "a/inner": { path: "outer/inner" } },
        })
      )
    ).toEqual(["a/inner"]);
  });
});

describe("confirmedReadings()", () => {
  const readings = parseRef("https://gitlab.com/a/b/c/d");

  /**
   * A record under a reading's key, carrying its repository, confirms it.
   *
   * confirmedReadings(readings, { "c/d": { repo: "gitlab.com/a/b" } }) // -> [a/b naming c/d]
   */
  it("should confirm the recipe reading an index recorded", () => {
    expect(
      settled(confirmedReadings(readings, { "c/d": { repo: "gitlab.com/a/b" } }))
    ).toEqual(["gitlab://a/b/-/c/d"]);
  });

  /**
   * A namespace reading is confirmed by a record for any recipe inside it.
   *
   * confirmedReadings(readings, { "d/x": { repo: "gitlab.com/a/b/c" } }) // -> [a/b/c naming d]
   */
  it("should confirm the namespace reading by a recipe recorded inside it", () => {
    expect(
      settled(confirmedReadings(readings, { "d/x": { repo: "gitlab.com/a/b/c" } }))
    ).toEqual(["gitlab://a/b/c/-/d"]);
  });

  /**
   * A browsed reading is confirmed by any record carrying its repository.
   *
   * confirmedReadings([browsed a/b/c, browsed a/b], { "w/x": { repo: "gitlab.com/a/b/c" } })
   */
  it("should confirm a browsed reading by its repository", () => {
    const browsed = parseRef("https://gitlab.com/a/b/c/-/tree/main/x");
    expect(confirmedReadings([...browsed, ...readings], { "w/x": { repo: "gitlab.com/a/b/c" } }))
      .toHaveLength(1);
  });

  /**
   * Nothing recorded confirms nothing, and one reading needs no record.
   *
   * confirmedReadings(readings, undefined) // -> []
   */
  it("should confirm nothing without a record, and pass one reading through", () => {
    expect(confirmedReadings(readings, undefined)).toEqual([]);
    expect(confirmedReadings(readings, { "c/d": { repo: "elsewhere" } })).toEqual([]);
    const one = parseRef("workflow/alpha");
    expect(confirmedReadings(one, undefined)).toBe(one);
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
          known: (reading) => reading.location?.identity === "gitlab.com/a/b/c",
        })!
      )
    ).toBe("gitlab://a/b/c/-/d");
    expect(settleDependency("gitlab://a/b/c/d", { known: () => true })).toBeUndefined();
    expect(settleDependency("gitlab://a/b/c/d")).toBeUndefined();
  });
});
