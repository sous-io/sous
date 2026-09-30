import { describe, expect, it } from "vitest";
import type { FetchLike } from "../providers/http.js";
import { parseRef } from "../../refs/parse.js";
import { needsSettling, settleDependencyLocations } from "./settle.js";
import type { RepoValidation } from "./validate.js";

/**
 * Unit tests for settling, at release time, the dependencies that read more
 * than one way. Every index is served by a fake fetch handed to the real
 * providers, so nothing here reaches a network.
 */

/** An index publishing the given recipe keys, each in `recipes/<key>`. */
function indexOf(keys: string[]): string {
  const namespaces: Record<string, object> = {};
  const recipes: Record<string, object> = {};
  for (const key of keys) {
    namespaces[key.split("/")[0]!] = {};
    recipes[key] = {
      path: `recipes/${key}`,
      versions: {
        "1.0.0": { hash: `sha256-${"a".repeat(64)}`, tag: `${key}@1.0.0`, prerelease: false },
      },
    };
  }
  return JSON.stringify({
    formatVersion: 1,
    name: "fixture",
    generatedAt: "2026-01-01T00:00:00.000Z",
    generator: "0.0.1",
    namespaces,
    recipes,
  });
}

/**
 * A fetch serving an index for each repository path named, and a 404 for
 * every other one; a path mapped to `"offline"` fails as the network would.
 */
function serving(byRepo: Record<string, string[] | "offline">): {
  fetchImpl: FetchLike;
  asked: string[];
} {
  const asked: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    asked.push(url);
    const match = /^https:\/\/[^/]+\/(.+?)(?:\/-\/raw|\/HEAD|\/raw)\//.exec(url);
    const repoPath = match?.[1]?.replace(/^raw\.githubusercontent\.com\//, "");
    const served = repoPath === undefined ? undefined : byRepo[repoPath];
    if (served === "offline") throw new Error("connection refused by gitlab.com");
    if (served === undefined) {
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => "",
        headers: { get: () => null },
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => indexOf(served),
      headers: { get: () => null },
    };
  };
  return { fetchImpl, asked };
}

/** A validated repository holding one recipe that declares the given dependencies. */
function validationWith(depends: string[]): RepoValidation {
  return {
    rootDir: "/repo",
    manifestPath: "/repo/sous.repo.yaml",
    manifest: { namespaces: { core: {} } },
    problems: [],
    recipes: [
      {
        path: "recipes/core/example",
        dir: "/repo/recipes/core/example",
        manifestPath: "/repo/recipes/core/example/sous.recipe.yaml",
        key: "core/example",
        raw: {},
        manifest: { namespace: "core", name: "example", version: "1.0.0", depends },
      },
    ],
  } as unknown as RepoValidation;
}

/** Settles a repository whose one recipe declares `depends`, against `byRepo`. */
async function settle(depends: string[], byRepo: Record<string, string[] | "offline">) {
  const { fetchImpl, asked } = serving(byRepo);
  const result = await settleDependencyLocations(validationWith(depends), {
    providerOptions: { env: { GITLAB_TOKEN: "t", GITHUB_TOKEN: "t" }, fetchImpl },
  });
  return { ...result, asked };
}

describe("needsSettling()", () => {
  /**
   * Only several readings, or a browser path, need an index to settle.
   *
   * needsSettling(parseRef("github://o/r/w/a")) // -> false
   * needsSettling(parseRef("gitlab://a/b/c/d")) // -> true
   */
  it("should say which dependencies need an index", () => {
    expect(needsSettling(parseRef("github://o/r/w/a"))).toBe(false);
    expect(needsSettling(parseRef("gitlab://a/b/c/d"))).toBe(true);
    expect(needsSettling(parseRef("https://github.com/o/r/tree/main/x"))).toBe(true);
  });
});

describe("settleDependencyLocations()", () => {
  /**
   * A dependency that reads one way is left alone and nothing is fetched, so a
   * repository using none of the ambiguous forms still releases offline.
   *
   * settle(["workflow/alpha", "github://o/r/w/a"]) // -> nothing settled, nothing fetched
   */
  it("should fetch nothing for dependencies that read one way", async () => {
    const { settled, problems, asked } = await settle(
      ["workflow/alpha", "github://o/r/w/a", "not a ref at all"],
      {}
    );
    expect(settled.size).toBe(0);
    expect(problems).toEqual([]);
    expect(asked).toEqual([]);
  });

  /**
   * A nested GitLab group is settled on the reading whose index publishes what
   * it names: here project a/b/c publishes the namespace d, and project a/b
   * does not publish c/d.
   *
   * settle(["gitlab://a/b/c/d"]) // -> gitlab.com/a/b/c, keys d/x and d/y
   */
  it("should keep the reading whose index publishes what it names", async () => {
    const { settled, problems } = await settle(["gitlab://a/b/c/d"], {
      "a/b": ["other/thing"],
      "a/b/c": ["d/x", "d/y"],
    });
    expect(problems).toEqual([]);
    expect(settled.get("gitlab://a/b/c/d")).toEqual({
      identity: "gitlab.com/a/b/c",
      keys: ["d/x", "d/y"],
    });
  });

  /**
   * The recipe reading settles the same way, keeping the range.
   *
   * settle(["https://gitlab.com/a/b/c/d@^1"]) // -> gitlab.com/a/b, key c/d, range ^1
   */
  it("should settle the recipe reading and keep its range", async () => {
    const { settled } = await settle(["https://gitlab.com/a/b/c/d"], {
      "a/b": ["c/d"],
      "a/b/c": ["other/y"],
    });
    expect(settled.get("https://gitlab.com/a/b/c/d")).toEqual({
      identity: "gitlab.com/a/b",
      keys: ["c/d"],
    });

    // A range leaves only recipe readings, and a recipe is always the last two
    // segments, so a ranged locator reads one way; a ranged browser URL is
    // what still needs settling.
    expect(needsSettling(parseRef("gitlab://a/b/c/d/e@^1"))).toBe(false);
    const url = "https://gitlab.com/a/b/-/tree/main/recipes/d/e@^1";
    const ranged = await settle([url], { "a/b": ["d/e"] });
    expect(ranged.settled.get(url)).toEqual({
      identity: "gitlab.com/a/b",
      keys: ["d/e"],
      range: "^1",
    });
  });

  /**
   * A browser URL is settled through the folder each recipe lives in.
   *
   * settle(["https://github.com/o/r/tree/main/recipes/workflow/alpha"]) // -> workflow/alpha
   */
  it("should settle a browser URL through the recipe folders", async () => {
    const url = "https://github.com/o/r/tree/main/recipes/workflow/alpha";
    const { settled } = await settle([url], { "o/r": ["workflow/alpha", "workflow/beta"] });
    expect(settled.get(url)).toEqual({ identity: "github.com/o/r", keys: ["workflow/alpha"] });
  });

  /**
   * A network failure fails the release rather than falling through to the
   * next reading, and says which index could not be read.
   *
   * settle(["gitlab://a/b/c/d"]) with a/b unreachable // -> an error problem
   */
  it("should fail on a network error instead of guessing", async () => {
    const { settled, problems } = await settle(["gitlab://a/b/c/d"], {
      "a/b": "offline",
      "a/b/c": ["d/x"],
    });
    expect(settled.size).toBe(0);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.level).toBe("error");
    expect(problems[0]!.where).toBe("recipes/core/example ('gitlab://a/b/c/d')");
    expect(problems[0]!.message).toContain("https://gitlab.com/a/b");
    expect(problems[0]!.message).toContain("never guesses");
  });

  /**
   * A missing index (a candidate that is not a recipe repository at all) is
   * the same kind of failure: nothing is assumed about it.
   *
   * settle(["gitlab://a/b/c/d"]) with no a/b index // -> an error problem
   */
  it("should fail when a candidate's index cannot be read", async () => {
    const { problems } = await settle(["gitlab://a/b/c/d"], { "a/b/c": ["d/x"] });
    expect(problems[0]!.message).toContain("could not be read");
  });

  /**
   * A genuine tie is an error naming the `/*` form that makes the namespace
   * reading explicit, and the canonical locator of the recipe reading.
   *
   * settle(["gitlab://a/b/c/d"]) where both a/b publishes c/d and a/b/c publishes d
   * // -> an error naming "gitlab://a/b/c/-/d/*"
   */
  it("should fail on a tie, naming the /* form", async () => {
    const { problems } = await settle(["gitlab://a/b/c/d"], {
      "a/b": ["c/d"],
      "a/b/c": ["d/x"],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("gitlab://a/b/c/-/d/*");
    expect(problems[0]!.message).toContain("gitlab://a/b/-/c/d");
  });

  /**
   * A dependency no reading's index publishes is an error listing the
   * readings.
   *
   * settle(["gitlab://a/b/c/d"]) where neither publishes it // -> an error
   */
  it("should fail when no reading is published", async () => {
    const { problems } = await settle(["gitlab://a/b/c/d"], {
      "a/b": ["other/x"],
      "a/b/c": ["other/y"],
    });
    expect(problems[0]!.message).toContain("no repository it could name publishes");
  });
});
