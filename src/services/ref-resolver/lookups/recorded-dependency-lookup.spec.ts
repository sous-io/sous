import { describe, expect, it } from "vitest";
import { candidates, findAll } from "../../../test/utils/ref-fixtures.js";
import { formatRef } from "../format.js";
import { RecordedDependencyLookup } from "./recorded-dependency-lookup.js";

/** The readings of a ref printed, for the ones the lookup confirms. */
async function confirmed(lookup: RecordedDependencyLookup, text: string): Promise<string[]> {
  return (await findAll(lookup, text)).map((match) => formatRef(match.ref));
}

describe("RecordedDependencyLookup", () => {
  /**
   * A record under a reading's key, carrying its repository, confirms it.
   *
   * { "c/d": { repo: "gitlab.com/a/b" } } confirms gitlab://a/b/-/c/d
   */
  it("should confirm the recipe reading an index recorded", async () => {
    const lookup = new RecordedDependencyLookup({ "c/d": { repo: "gitlab.com/a/b" } });
    expect(await confirmed(lookup, "https://gitlab.com/a/b/c/d")).toEqual(["gitlab://a/b/-/c/d"]);
  });

  /**
   * A namespace reading is confirmed by a record for any recipe inside it.
   *
   * { "d/x": { repo: "gitlab.com/a/b/c" } } confirms gitlab://a/b/c/-/d
   */
  it("should confirm the namespace reading by a recipe recorded inside it", async () => {
    const lookup = new RecordedDependencyLookup({ "d/x": { repo: "gitlab.com/a/b/c" } });
    expect(await confirmed(lookup, "https://gitlab.com/a/b/c/d")).toEqual(["gitlab://a/b/c/-/d"]);
  });

  /**
   * A browsed reading is confirmed by any record carrying its repository.
   *
   * { "w/x": { repo: "gitlab.com/a/b/c" } } confirms the browser URL of a/b/c
   */
  it("should confirm a browsed reading by its repository", async () => {
    const lookup = new RecordedDependencyLookup({ "w/x": { repo: "gitlab.com/a/b/c" } });
    expect(await findAll(lookup, "https://gitlab.com/a/b/c/-/tree/main/x")).toHaveLength(1);
    expect(await findAll(lookup, "https://gitlab.com/a/b/-/tree/main/x")).toEqual([]);
  });

  /**
   * Nothing recorded confirms nothing, and a record for another repository
   * confirms nothing here.
   *
   * new RecordedDependencyLookup(undefined) // finds nothing
   */
  it("should confirm nothing without a record", async () => {
    expect(await confirmed(new RecordedDependencyLookup(undefined), "gitlab://a/b/c/d")).toEqual([]);
    const elsewhere = new RecordedDependencyLookup({ "c/d": { repo: "elsewhere" } });
    expect(await confirmed(elsewhere, "gitlab://a/b/c/d")).toEqual([]);
  });

  /**
   * A sibling (no location) is confirmed by a record that names no
   * repository, and kinds that are not repositories, namespaces or recipes are
   * never confirmed.
   *
   * { "workflow/alpha": {} } confirms the recipe workflow/alpha
   */
  it("should confirm a sibling by a record with no repository", async () => {
    const lookup = new RecordedDependencyLookup({ "workflow/alpha": {} });
    expect(await confirmed(lookup, "workflow/alpha")).toEqual(["workflow/alpha"]);
    expect(await confirmed(lookup, "workflow")).toEqual(["workflow"]);
    for (const candidate of candidates("SOUS_VAR_X")) expect(await lookup.find(candidate)).toEqual([]);
  });
});
