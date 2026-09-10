/**
 * Unit tests for the index cache: freshness, refetching, and the last-good
 * fallback that keeps a failed upstream check from breaking a build.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { IndexCache, INDEX_CACHE_DIRNAME } from "./index-cache.js";
import type { CanonicalRepo, FetchedIndex, RepoProvider } from "./provider.js";
import { makeTmpDir, type TmpDir } from "../../../test/utils/tmp.js";
import { makeIndexFile } from "../../../test/utils/repo-fixtures.js";

/** A provider stand-in that answers with whatever the test tells it to. */
class StubProvider implements RepoProvider {
  readonly id = "github" as const;

  readonly features = ["fetch" as const];

  calls = 0;

  constructor(
    private readonly answer: () => FetchedIndex | Promise<FetchedIndex>
  ) {}

  matches(): boolean {
    return true;
  }

  canonicalize(url: string): CanonicalRepo {
    return {
      host: "github.com",
      owner: "sous-io",
      name: "sous-recipes",
      httpsUrl: `${url}.git`,
      sshUrl: "git@github.com:sous-io/sous-recipes.git",
    };
  }

  async fetchIndex(): Promise<FetchedIndex> {
    this.calls += 1;
    return this.answer();
  }

  async fetchRecipeTree(): Promise<void> {
    // The cache never fetches a recipe tree.
  }
}

const REPO_URL = "https://github.com/sous-io/sous-recipes";

const INDEX_TEXT = JSON.stringify(
  makeIndexFile("sous-recipes", { "workflow/task-files": ["1.0.0"] })
);

describe("IndexCache", () => {
  let tmp: TmpDir;
  let warnings: string[];

  beforeEach(() => {
    tmp = makeTmpDir("sous-index-cache-");
    warnings = [];
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /** Builds a cache over the temp directory, with a fixed clock. */
  function makeCache(provider: RepoProvider, nowIso = "2026-01-01T00:00:00.000Z"): IndexCache {
    return new IndexCache({
      storeRoot: tmp.path,
      resolveProvider: () => provider,
      now: () => new Date(nowIso),
      warn: (message) => warnings.push(message),
    });
  }

  /**
   * The first lookup has nothing cached, so it fetches, validates and writes
   * both the index and its sidecar under `<storeRoot>/_indexes/`.
   *
   * getIndex("sous-recipes", { url }) // -> { source: "network", ... }
   */
  it("should fetch and cache an index that is not on disk yet", async () => {
    const provider = new StubProvider(() => ({ text: INDEX_TEXT, ref: "HEAD", etag: 'W/"1"' }));
    const cache = makeCache(provider);

    const result = await cache.getIndex("sous-recipes", { url: REPO_URL });

    expect(result.source).toBe("network");
    expect(Object.keys(result.index.recipes)).toEqual(["workflow/task-files"]);
    expect(fs.existsSync(path.join(tmp.path, INDEX_CACHE_DIRNAME, "sous-recipes.json"))).toBe(true);
    expect(cache.readMeta("sous-recipes")).toMatchObject({
      fetchedAt: "2026-01-01T00:00:00.000Z",
      etag: 'W/"1"',
    });
  });

  /**
   * A cached copy inside the freshness window is used as is: the provider is
   * never asked a second time.
   */
  it("should return the cached copy while it is fresh", async () => {
    const provider = new StubProvider(() => ({ text: INDEX_TEXT, ref: "HEAD" }));
    const cache = makeCache(provider);

    await cache.getIndex("sous-recipes", { url: REPO_URL });
    const second = await cache.getIndex("sous-recipes", { url: REPO_URL, maxAgeSeconds: 300 });

    expect(second.source).toBe("cache");
    expect(provider.calls).toBe(1);
  });

  /**
   * Once the window has lapsed the cache asks upstream again. A zero-second
   * window is the "always check" case watch mode uses.
   */
  it("should refetch once the freshness window has lapsed", async () => {
    const provider = new StubProvider(() => ({ text: INDEX_TEXT, ref: "HEAD" }));
    const cache = makeCache(provider);

    await cache.getIndex("sous-recipes", { url: REPO_URL });
    const second = await cache.getIndex("sous-recipes", { url: REPO_URL, maxAgeSeconds: 0 });

    expect(second.source).toBe("network");
    expect(provider.calls).toBe(2);
  });

  /**
   * A failed check never breaks a build: when a cached copy exists, it is
   * returned and the failure is reported as a warning.
   */
  it("should fall back to the stale copy and warn when the fetch fails", async () => {
    let fail = false;
    const provider = new StubProvider(() => {
      if (fail) throw new Error("network is unreachable");
      return { text: INDEX_TEXT, ref: "HEAD" };
    });
    const cache = makeCache(provider);

    await cache.getIndex("sous-recipes", { url: REPO_URL });
    fail = true;
    const second = await cache.getIndex("sous-recipes", { url: REPO_URL, maxAgeSeconds: 0 });

    expect(second.source).toBe("stale");
    expect(Object.keys(second.index.recipes)).toEqual(["workflow/task-files"]);
    expect(warnings.join("\n")).toContain("could not check the repository 'sous-recipes'");
  });

  /**
   * With nothing cached there is no last-good copy to stand in, so the failure
   * is raised instead of being swallowed.
   */
  it("should raise when the fetch fails and nothing is cached", async () => {
    const provider = new StubProvider(() => {
      throw new Error("network is unreachable");
    });
    const cache = makeCache(provider);

    await expect(cache.getIndex("sous-recipes", { url: REPO_URL })).rejects.toThrow(
      /network is unreachable/
    );
    expect(warnings).toEqual([]);
  });

  /**
   * An index that is not JSON, or does not fit the schema, is a broken
   * publication: the error should name the repository rather than the parser.
   */
  it("should raise a readable error when the published index is not valid", async () => {
    const provider = new StubProvider(() => ({ text: "not json at all", ref: "HEAD" }));
    const cache = makeCache(provider);

    await expect(cache.getIndex("sous-recipes", { url: REPO_URL })).rejects.toThrow(
      /is not valid JSON/
    );
  });

  /**
   * forget should remove both files, which is what withdrawing trust from a
   * repository does.
   */
  it("should forget a cached index and its sidecar", async () => {
    const provider = new StubProvider(() => ({ text: INDEX_TEXT, ref: "HEAD" }));
    const cache = makeCache(provider);

    await cache.getIndex("sous-recipes", { url: REPO_URL });
    cache.forget("sous-recipes");

    expect(cache.readCached("sous-recipes")).toBeUndefined();
    expect(cache.readMeta("sous-recipes")).toBeUndefined();
  });
});
