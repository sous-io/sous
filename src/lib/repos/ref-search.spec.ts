import { describe, it, expect } from "vitest";
import { describeIndexSearch } from "./ref-search.js";
import type { IndexFile } from "./formats/index-file.js";

/**
 * What a repository search says it looked in. Resolving a ref itself is covered
 * by `src/lib/refs/find.spec.ts`; all that is left here is the sentence a name
 * that matched nothing is explained with.
 */

/** Builds an index holding the given `namespace/recipe` keys. */
function indexOf(name: string, keys: string[]): IndexFile {
  const recipes: Record<string, unknown> = {};
  const declared: Record<string, unknown> = {};

  for (const key of keys) {
    declared[key.slice(0, key.indexOf("/"))] = {};
    recipes[key] = {
      path: `recipes/${key}`,
      versions: {
        "1.0.0": { hash: "sha256:0", tag: `${key}@1.0.0`, prerelease: false },
      },
    };
  }

  return {
    formatVersion: 1,
    name,
    generatedAt: "2026-01-01T00:00:00.000Z",
    generator: "1.0.0",
    namespaces: declared,
    recipes,
  } as unknown as IndexFile;
}

describe("describeIndexSearch()", () => {
  /**
   * The message separates the repositories that were searched from the ones
   * whose index could not be read, so a reader can tell a wrong name from a
   * repository that was never fetched.
   *
   * describeIndexSearch({ name: "missing", repoOrder: ["fixtures", "offline"], indexes })
   * // -> ["  Searched the namespaces and the recipe names of: fixtures.", "  These ..."]
   */
  it("should name the repositories searched and the ones with no readable index", () => {
    const lines = describeIndexSearch({
      name: "missing",
      repoOrder: ["fixtures", "offline"],
      indexes: new Map([["fixtures", indexOf("fixtures", ["workflow/task-files"])]]),
    });

    expect(lines.join("\n")).toContain("fixtures");
    expect(lines.join("\n")).toContain("offline");
  });

  /**
   * With no readable index at all, the message says so rather than naming an
   * empty list of repositories.
   *
   * describeIndexSearch({ name: "missing", repoOrder: ["offline"], indexes: new Map() })
   * // -> ["  No repository index could be read, so there was nothing to search.", ...]
   */
  it("should say nothing could be searched when no index was readable", () => {
    const lines = describeIndexSearch({
      name: "missing",
      repoOrder: ["offline"],
      indexes: new Map(),
    });

    expect(lines[0]).toContain("No repository index could be read");
  });
});
