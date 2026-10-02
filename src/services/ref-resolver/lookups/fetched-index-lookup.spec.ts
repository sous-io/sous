import { describe, expect, it } from "vitest";
import type { IndexFile } from "../../../lib/repos/formats/index-file.js";
import type { FetchLike } from "../../../lib/repos/providers/http.js";
import { candidates, findAll, indexOf, keysOf } from "../../../test/utils/ref-fixtures.js";
import { locationOf } from "../parts.js";
import { FetchedIndexLookup } from "./fetched-index-lookup.js";

/** A lookup whose fetcher serves the given repositories, keyed by identity; `"offline"` fails as a network would. */
function serving(byIdentity: Record<string, string[] | "offline">) {
  const asked: string[] = [];
  const lookup = new FetchedIndexLookup({
    fetchIndex: async (location): Promise<IndexFile> => {
      asked.push(location.identity);
      const served = byIdentity[location.identity];
      if (served === "offline") throw new Error("connection refused");
      if (served === undefined) throw new Error("404 Not Found");
      return indexOf(served);
    },
  });
  return { lookup, asked };
}

describe("FetchedIndexLookup.find()", () => {
  /**
   * A candidate with no location names no repository to fetch from, and
   * nothing is fetched for it.
   *
   * find("workflow/alpha") // -> [], no fetch
   */
  it("should fetch nothing for a candidate with no location", async () => {
    const { lookup, asked } = serving({});
    expect(await findAll(lookup, "workflow/alpha")).toEqual([]);
    expect(asked).toEqual([]);
  });

  /**
   * A nested GitLab group is answered by the reading whose index publishes
   * what it names, and each repository is fetched once.
   *
   * gitlab://a/b/c/d with a/b/c publishing d/x // -> the namespace d in a/b/c
   */
  it("should match the reading whose index publishes it, fetching each index once", async () => {
    const { lookup, asked } = serving({ "gitlab.com/a/b": ["other/thing"], "gitlab.com/a/b/c": ["d/x", "d/y"] });
    const matches = await findAll(lookup, "gitlab://a/b/c/d");
    expect(keysOf(matches)).toEqual(["namespace:gitlab.com/a/b/c:d"]);
    await findAll(lookup, "gitlab://a/b/c/d");
    expect(new Set(asked)).toEqual(new Set(["gitlab.com/a/b", "gitlab.com/a/b/c"]));
    expect(asked).toHaveLength(2);
  });

  /**
   * A browser URL is settled through the folder each recipe lives in.
   *
   * .../tree/main/recipes/workflow/alpha // -> workflow/alpha
   */
  it("should settle a browser URL through the recipe folders", async () => {
    const { lookup } = serving({ "github.com/o/r": ["workflow/alpha", "workflow/beta"] });
    const matches = await findAll(lookup, "https://github.com/o/r/tree/main/recipes/workflow/alpha");
    expect(keysOf(matches)).toEqual(["recipe:github.com/o/r:workflow/alpha"]);
  });

  /**
   * A network failure throws, saying which index could not be read, rather
   * than falling through to the next reading.
   *
   * gitlab://a/b/c/d with a/b unreachable // rejects
   */
  it("should throw when an index cannot be fetched", async () => {
    const { lookup } = serving({ "gitlab.com/a/b": "offline", "gitlab.com/a/b/c": ["d/x"] });
    await expect(findAll(lookup, "gitlab://a/b/c/d")).rejects.toThrow(/https:\/\/gitlab.com\/a\/b.*never guesses/s);
    const { lookup: missing } = serving({ "gitlab.com/a/b/c": ["d/x"] });
    await expect(findAll(missing, "gitlab://a/b/c/d")).rejects.toThrow("could not be read");
  });

  /**
   * The caller says what the ref being settled is called, so a release can say
   * "the dependency" and an include can say "the include", and a browser path
   * is a folder.
   *
   * subject "dependency", a browsed ref with an unreachable index // "the dependency reads as a folder in"
   */
  it("should name the subject, and say when it is a folder", async () => {
    const failing = new FetchedIndexLookup({
      subject: "dependency",
      fetchIndex: async () => {
        throw new Error("connection refused");
      },
    });
    await expect(findAll(failing, "gitlab://a/b/c/d")).rejects.toThrow(
      /the dependency reads as something in the repository at https:\/\/gitlab.com\/a\/b\/c, and its index could not be read, so the release cannot settle what it means/
    );
    await expect(findAll(failing, "https://github.com/o/r/tree/main/x")).rejects.toThrow(
      /the dependency reads as a folder in the repository at https:\/\/github.com\/o\/r/
    );
  });

  /**
   * The index at a location is available to a caller that needs more than the
   * match, and is fetched once.
   *
   * indexAt(location) twice // -> the same index, one fetch
   */
  it("should hand out the index at a location, fetched once", async () => {
    const { lookup, asked } = serving({ "github.com/o/r": ["w/a"] });
    const located = candidates("github://o/r/w/a").find((ref) => ref.kind === "recipe")!;
    const location = locationOf(located)!;
    const first = await lookup.indexAt(location);
    expect(Object.keys(first.recipes)).toEqual(["w/a"]);
    expect(await lookup.indexAt(location)).toBe(first);
    expect(asked).toEqual(["github.com/o/r"]);
  });

  /**
   * The default fetcher goes through the provider layer, with the fetch
   * implementation handed in.
   *
   * a fake fetch serving an index // the lookup finds a recipe in it
   */
  it("should fetch through the provider layer by default", async () => {
    const index = JSON.stringify(indexOf(["workflow/alpha"]));
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => index,
      headers: { get: () => null },
    });
    const lookup = new FetchedIndexLookup({
      providerOptions: { env: { GITHUB_TOKEN: "t" }, fetchImpl },
    });
    expect(keysOf(await findAll(lookup, "github://o/r/workflow/alpha"))).toEqual([
      "recipe:github.com/o/r:workflow/alpha",
    ]);
  });
});

describe("FetchedIndexLookup.settle()", () => {
  /**
   * Exactly one reading may publish what is named; that match is returned.
   *
   * settle(readings of gitlab://a/b/c/d) with only a/b publishing c/d // -> a/b's recipe
   */
  it("should return the one reading an index confirms", async () => {
    const { lookup } = serving({ "gitlab.com/a/b": ["c/d"], "gitlab.com/a/b/c": ["other/y"] });
    const match = await lookup.settle(candidates("https://gitlab.com/a/b/c/d"));
    expect(keysOf([match])).toEqual(["recipe:gitlab.com/a/b:c/d"]);
  });

  /**
   * A genuine tie is an error naming the `/*` form that reads one way, and
   * the canonical locator of the recipe reading.
   *
   * a/b publishes c/d and a/b/c publishes d // names "gitlab://a/b/c/-/d/*"
   */
  it("should fail on a tie, naming the /* form", async () => {
    const { lookup } = serving({ "gitlab.com/a/b": ["c/d"], "gitlab.com/a/b/c": ["d/x"] });
    const error = await lookup.settle(candidates("gitlab://a/b/c/d")).catch((e: Error) => e);
    expect((error as Error).message).toContain("gitlab://a/b/c/-/d/*");
    expect((error as Error).message).toContain("gitlab://a/b/-/c/d");
  });

  /**
   * When no reading is published the error lists how it was read.
   *
   * neither publishes it // "no repository it could name publishes what it names"
   */
  it("should fail when no reading is published", async () => {
    const { lookup } = serving({ "gitlab.com/a/b": ["other/x"], "gitlab.com/a/b/c": ["other/y"] });
    await expect(lookup.settle(candidates("gitlab://a/b/c/d"))).rejects.toThrow(
      "no repository it could name publishes"
    );
  });
});
