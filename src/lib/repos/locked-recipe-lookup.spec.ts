import { describe, expect, it } from "vitest";
import { RefSource, sharedRefResolver } from "../../services/ref-resolver/index.js";
import { LockedRecipeFileLookup } from "./locked-recipe-lookup.js";

const lookup = new LockedRecipeFileLookup([
  { namespace: "workflow", name: "task-files", repo: "main" },
  { namespace: "workflow", name: "github-projects", repo: "main" },
  { namespace: "core", name: "sous-skills", repo: "builtin" },
]);

/** The `namespace/recipe` keys an include reference matches, in order. */
function keys(reference: string): string[] {
  const result = sharedRefResolver().parse(reference, RefSource.Include);
  return result.refs
    .flatMap((ref) => lookup.findSync(ref))
    .map((match) => (match.ref.kind === "recipeFile" ? `${match.ref.recipe.namespace?.name}/${match.ref.recipe.name}` : ""));
}

describe("LockedRecipeFileLookup", () => {
  /**
   * An exact reference finds the one recipe, with the path carried through.
   *
   * findSync(workflow/task-files/_partials/x.md) // -> workflow/task-files, path _partials/x.md
   */
  it("should find the recipe an include names", () => {
    const [candidate] = sharedRefResolver().parse("workflow/task-files/_partials/x.md", RefSource.Include).refs;
    const matches = lookup.findSync(candidate!);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.exactSpelling).toBe(true);
    expect(matches[0]?.ref).toMatchObject({ kind: "recipeFile", path: "_partials/x.md" });
  });

  /**
   * A name in another case matches, but not as an exact spelling, and the
   * known spelling is returned.
   *
   * Workflow/Task-Files // -> workflow/task-files, exactSpelling false
   */
  it("should match ignoring case and report it is not exact", () => {
    const [candidate] = sharedRefResolver().parse("Workflow/Task-Files/x.md", RefSource.Include).refs;
    const matches = lookup.findSync(candidate!);
    expect(matches.map((m) => m.exactSpelling)).toEqual([false]);
    expect(keys("Workflow/Task-Files/x.md")).toEqual(["workflow/task-files"]);
  });

  /**
   * Globs in the namespace and recipe names match every recipe, sorted by key.
   *
   * workflow/* /memories/a.md // -> both workflow recipes
   */
  it("should match globs in names and sort the matches by key", () => {
    expect(keys("*/*/memories/a.md")).toEqual([
      "core/sous-skills",
      "workflow/github-projects",
      "workflow/task-files",
    ]);
    expect(keys("workflow/task-*/m.md")).toEqual(["workflow/task-files"]);
  });

  /**
   * A repo qualifier keeps only the recipes of that repository, by short name.
   *
   * main:*\/*\/m.md // -> the two workflow recipes
   */
  it("should keep only the recipes of a repo qualifier", () => {
    expect(keys("main:*/*/m.md")).toEqual(["workflow/github-projects", "workflow/task-files"]);
    expect(keys("nowhere:*/*/m.md")).toEqual([]);
  });

  /** A recipe nobody pins finds nothing, and the helpers say what is known. */
  it("should find nothing for an unknown recipe and list what it knows", () => {
    expect(keys("workflow/gone/x.md")).toEqual([]);
    expect(lookup.namespaces()).toEqual(["core", "workflow"]);
    expect(lookup.recipesInNamespace("workflow")).toEqual([
      "workflow/github-projects",
      "workflow/task-files",
    ]);
    expect(lookup.knowsNamespace("WORKFLOW")).toBe(true);
    expect(lookup.knowsNamespace("nope")).toBe(false);
  });

  /** `find` answers what `findSync` answers. */
  it("should answer asynchronously the same as synchronously", async () => {
    const [candidate] = sharedRefResolver().parse("core/sous-skills/x.md", RefSource.Include).refs;
    expect(await lookup.find(candidate!)).toEqual(lookup.findSync(candidate!));
  });
});
