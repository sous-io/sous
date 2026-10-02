import { describe, expect, it } from "vitest";
import { candidates, findAll, indexOf, keysOf } from "../../../test/utils/ref-fixtures.js";
import { formatRef } from "../format.js";
import { CachedIndexLookup } from "./cached-index-lookup.js";

/** Two repositories: `fixtures` (searched first) and `other`, with nested recipe folders. */
const lookup = new CachedIndexLookup(
  new Map([
    ["fixtures", indexOf(["workflow/task-files", "workflow/alpha", "tooling/lint"], { "workflow/alpha": "The alpha recipe" })],
    ["other", indexOf(["workflow/task-files"])],
  ]),
  {
    order: ["fixtures", "other"],
    urls: { fixtures: "https://github.com/o/fixtures", other: "https://github.com/o/other.git" },
  }
);

describe("CachedIndexLookup", () => {
  /**
   * A bare word names a namespace in the repository publishing it, and the
   * known ref carries the repository as its parent.
   *
   * find("workflow") // -> the namespace in fixtures, then in other
   */
  it("should find a namespace by its bare name", async () => {
    const matches = (await findAll(lookup, "workflow")).filter((m) => m.ref.kind === "namespace");
    expect(keysOf(matches)).toEqual(["namespace:fixtures:workflow", "namespace:other:workflow"]);
  });

  /**
   * A repository short name qualifies a namespace and a recipe.
   *
   * find("other:workflow/task-files") // -> only other's recipe
   */
  it("should find a recipe by its qualified name", async () => {
    expect(keysOf(await findAll(lookup, "other:workflow/task-files"))).toEqual([
      "recipe:other:workflow/task-files",
    ]);
    expect(keysOf(await findAll(lookup, "workflow/task-files"))).toEqual([
      "recipe:fixtures:workflow/task-files",
      "recipe:other:workflow/task-files",
    ]);
  });

  /**
   * A bare recipe name matches in any namespace, and the publisher's
   * description rides on the known ref.
   *
   * find("alpha") // -> workflow/alpha, described
   */
  it("should find a recipe by its bare name and carry its description", async () => {
    const [match] = (await findAll(lookup, "alpha")).filter((m) => m.ref.kind === "recipe");
    expect(match?.ref.description).toBe("The alpha recipe");
    expect(match?.ref).toMatchObject({ name: "alpha", namespace: { name: "workflow" } });
  });

  /**
   * A repository is found by its short name, and by its location whatever
   * short name the project gave it.
   *
   * find("fixtures") // -> the repository; find("https://github.com/o/other") // -> other
   */
  it("should find a repository by name and by location", async () => {
    expect(keysOf(await findAll(lookup, "fixtures")).filter((k) => k.startsWith("repo:"))).toEqual([
      "repo:fixtures",
    ]);
    const byUrl = (await findAll(lookup, "git@github.com:o/other.git")).map((m) => m.ref);
    expect(byUrl).toHaveLength(1);
    expect(byUrl[0]).toMatchObject({ kind: "repo", name: "other" });
  });

  /**
   * A ref written as a location finds the namespace or recipe through the
   * repository at that location, settled through its index.
   *
   * find("github://o/other/workflow/task-files") // -> other's recipe
   */
  it("should settle a located ref through the repository at that location", async () => {
    const matches = await findAll(lookup, "https://github.com/o/other/workflow/task-files@^1");
    expect(keysOf(matches)).toEqual(["recipe:other:workflow/task-files"]);
    expect(formatRef(matches[0]!.ref)).toContain("@^1");
  });

  /**
   * The exact spelling is flagged, and a spelling differing only in case is
   * returned flagged as such.
   *
   * find("Workflow") // -> workflow, folded
   */
  it("should flag whether the spelling matched exactly", async () => {
    const exact = await findAll(lookup, "workflow");
    expect(exact.every((m) => m.exactSpelling)).toBe(true);
    const folded = (await findAll(lookup, "Workflow")).filter((m) => m.ref.kind === "namespace");
    expect(keysOf(folded)).toEqual(["namespace:fixtures:workflow (folded)", "namespace:other:workflow (folded)"]);
  });

  /**
   * A glob in a name matches every name it covers.
   *
   * find("workflow/*") // -> every recipe in workflow
   */
  it("should match glob patterns", async () => {
    const recipes = (await findAll(lookup, "fixtures:workflow/*")).filter((m) => m.ref.kind === "recipe");
    expect(keysOf(recipes)).toEqual(["recipe:fixtures:workflow/alpha", "recipe:fixtures:workflow/task-files"]);
    const names = (await findAll(lookup, "t*")).filter((m) => m.ref.kind === "namespace");
    expect(keysOf(names)).toEqual(["namespace:fixtures:tooling"]);
  });

  /**
   * Kinds the cached indexes know nothing about, and refs they do not
   * publish, have no match.
   *
   * find("nothing") // -> []
   */
  it("should return nothing for what is not published", async () => {
    expect(await findAll(lookup, "nothing")).toEqual([]);
    for (const candidate of candidates("SOUS_VAR_X")) {
      expect(await lookup.find(candidate)).toEqual([]);
    }
  });

  /**
   * A browser URL settles through the folder each recipe lives in, whatever
   * the branch is called, and records the branch as the revision.
   *
   * find(".../tree/feature/x/recipes/workflow/alpha") // -> workflow/alpha at revision feature/x
   */
  it("should settle a browser URL behind any branch", async () => {
    const [match] = await findAll(
      lookup,
      "https://github.com/o/fixtures/tree/feature/x/recipes/workflow/alpha"
    );
    expect(keysOf([match!])).toEqual(["recipe:fixtures:workflow/alpha"]);
    expect(match!.ref).toMatchObject({ namespace: { repo: { revision: "feature/x" } } });
  });

  /**
   * A file inside a recipe's folder names that recipe; a folder above one
   * namespace's recipes names the namespace; anything else names nothing.
   *
   * find(".../tree/main/recipes/workflow") // -> the namespace workflow
   */
  it("should settle files, namespace folders and non-recipe folders", async () => {
    const base = "https://github.com/o/fixtures";
    expect(keysOf(await findAll(lookup, `${base}/blob/main/recipes/tooling/lint/skills/SKILL.md`))).toEqual([
      "recipe:fixtures:tooling/lint",
    ]);
    expect(keysOf(await findAll(lookup, `${base}/tree/main/recipes/tooling`))).toEqual([
      "namespace:fixtures:tooling",
    ]);
    expect(await findAll(lookup, `${base}/tree/main/docs`)).toEqual([]);
    expect(await findAll(lookup, "https://github.com/o/unknown/tree/main/recipes/tooling")).toEqual([]);
  });

  /**
   * The deepest recipe wins when one recipe's folder sits inside another's,
   * and a folder holding several namespaces names none.
   *
   * a/outer at "outer", a/inner at "outer/inner" // browsing outer/inner -> a/inner
   */
  it("should prefer the deepest recipe folder and refuse mixed namespaces", async () => {
    const nested = new CachedIndexLookup(new Map([["n", indexOf(["a/x", "b/y"])]]), {
      urls: { n: "https://github.com/o/n" },
    });
    expect(await findAll(nested, "https://github.com/o/n/tree/main/recipes")).toEqual([]);

    const index = indexOf(["a/outer", "a/inner"]);
    index.recipes["a/outer"]!.path = "outer";
    index.recipes["a/inner"]!.path = "outer/inner";
    const deep = new CachedIndexLookup(new Map([["n", index]]), { urls: { n: "https://github.com/o/n" } });
    expect(keysOf(await findAll(deep, "https://github.com/o/n/tree/main/outer/inner"))).toEqual([
      "recipe:n:a/inner",
    ]);
  });
});
