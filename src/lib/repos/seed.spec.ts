import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTmpDir, type TmpDir } from "../../test/utils/tmp.js";
import { SOUS_VERSION } from "../settings.js";
import {
  CORE_RECIPE_KEY,
  OFFICIAL_REPO_IDENTITY,
  OFFICIAL_REPO_NAME,
} from "./core-recipe.js";
import { parseIndexFile } from "./formats/index-file.js";
import { INDEX_CACHE_DIRNAME, INDEX_SIDECAR_SUFFIX } from "./providers/index-cache.js";
import { RecipeStore } from "./store/recipe-store.js";
import type { IndexOverlay } from "./providers/index-cache.js";
import { SEED_INDEX_COMMENT, coreIndexOverlay, seedCoreRecipe } from "./seed.js";

const tmpDirs: TmpDir[] = [];

/** Creates a temp dir that is cleaned up after the test. */
function tmp(): string {
  const dir = makeTmpDir("sous-seed-");
  tmpDirs.push(dir);
  return dir.path;
}

/** A store rooted in a fresh temp directory. */
function makeStore(): { store: RecipeStore; root: string } {
  const root = path.join(tmp(), "cache");
  return { store: new RecipeStore({ root, onWarning: () => {} }), root };
}

/** Where the cached index for the official repository is written. */
function indexPath(root: string): string {
  const segments = OFFICIAL_REPO_IDENTITY.split("/");
  const last = segments.pop()!;
  return path.join(root, INDEX_CACHE_DIRNAME, ...segments, `${last}.json`);
}

/** Reads and validates whatever index is cached for the official repository. */
function readIndex(root: string) {
  return parseIndexFile(JSON.parse(fs.readFileSync(indexPath(root), "utf8")), "test");
}

afterEach(() => {
  while (tmpDirs.length > 0) tmpDirs.pop()!.cleanup();
});

describe("seedCoreRecipe()", () => {
  /**
   * The first run on a machine has an empty store and an empty index cache, so
   * it copies the packaged recipe in and writes the stand-in index that lets the
   * resolver see it.
   */
  it("copies the packaged core recipe into an empty store", async () => {
    const { store, root } = makeStore();

    const report = await seedCoreRecipe({ store, sousVersion: SOUS_VERSION });

    expect(report.seeded).toBe(true);
    expect(report.alreadyPresent).toBe(false);
    expect(report.wroteIndex).toBe(true);
    expect(report.version).toBe(SOUS_VERSION);
    expect(report.skippedBecause).toBeUndefined();

    const entryDir = store.entryDir({
      identity: OFFICIAL_REPO_IDENTITY,
      namespace: "core",
      name: "sous-skills",
      version: SOUS_VERSION,
    });
    expect(fs.existsSync(path.join(entryDir, "sous.recipe.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(entryDir, "skills", "about-sous", "SKILL.tpl.md"))).toBe(
      true
    );
    expect(root).toBe(store.root);
  });

  /**
   * The stand-in index has to be a real, valid index: the resolver reads it with
   * exactly the same code that reads a fetched one.
   */
  it("writes a valid stand-in index naming the seeded version", async () => {
    const { store, root } = makeStore();
    await seedCoreRecipe({ store, sousVersion: SOUS_VERSION });

    const index = readIndex(root);
    expect(index.$comment).toBe(SEED_INDEX_COMMENT);
    expect(index.name).toBe(OFFICIAL_REPO_NAME);
    expect(Object.keys(index.namespaces)).toEqual(["core"]);
    expect(Object.keys(index.recipes)).toEqual([CORE_RECIPE_KEY]);

    const recipe = index.recipes[CORE_RECIPE_KEY]!;
    expect(Object.keys(recipe.versions)).toEqual([SOUS_VERSION]);
    expect(recipe.versions[SOUS_VERSION]!.tag).toBe(`${CORE_RECIPE_KEY}@${SOUS_VERSION}`);
    expect(recipe.versions[SOUS_VERSION]!.prerelease).toBe(false);
  });

  /**
   * The hash the index publishes must be the hash the store actually computed,
   * or the entry would be refetched on every build.
   */
  it("publishes the hash of the entry it just wrote", async () => {
    const { store, root } = makeStore();
    const report = await seedCoreRecipe({ store, sousVersion: SOUS_VERSION });

    const hit = await store.get({
      identity: OFFICIAL_REPO_IDENTITY,
      namespace: "core",
      name: "sous-skills",
      version: SOUS_VERSION,
    });

    expect(hit?.entry.hash).toBe(report.hash);
    expect(readIndex(root).recipes[CORE_RECIPE_KEY]!.versions[SOUS_VERSION]!.hash).toBe(
      report.hash
    );
  });

  /**
   * Seeding runs before every build, so the second run must do nothing at all.
   */
  it("does nothing on a second run", async () => {
    const { store } = makeStore();
    await seedCoreRecipe({ store, sousVersion: SOUS_VERSION });

    const second = await seedCoreRecipe({ store, sousVersion: SOUS_VERSION });

    expect(second.seeded).toBe(false);
    expect(second.alreadyPresent).toBe(true);
    expect(second.wroteIndex).toBe(false);
  });

  /**
   * An index a repository actually published is the truth about that repository,
   * so the seed must never write over it.
   */
  it("leaves a real cached index alone", async () => {
    const { store, root } = makeStore();
    const real = {
      formatVersion: 1,
      name: OFFICIAL_REPO_NAME,
      generatedAt: "2026-01-01T00:00:00.000Z",
      generator: "9.9.9",
      namespaces: { core: {} },
      recipes: {
        [CORE_RECIPE_KEY]: {
          path: "recipes/core/sous-skills",
          versions: {
            "9.9.9": {
              hash: `sha256-${"a".repeat(64)}`,
              tag: `${CORE_RECIPE_KEY}@9.9.9`,
              prerelease: false,
            },
          },
        },
      },
    };
    fs.mkdirSync(path.dirname(indexPath(root)), { recursive: true });
    fs.writeFileSync(indexPath(root), JSON.stringify(real), "utf8");

    const report = await seedCoreRecipe({ store, sousVersion: SOUS_VERSION });

    expect(report.seeded).toBe(true);
    expect(report.wroteIndex).toBe(false);
    expect(readIndex(root).generator).toBe("9.9.9");
  });

  /**
   * Its own stand-in, on the other hand, is replaced as soon as it stops naming
   * the version being seeded. That is how a machine that upgrades sous while
   * offline ends up with an index naming the new version.
   */
  it("replaces its own stand-in when the version it seeds has changed", async () => {
    const { store, root } = makeStore();
    await seedCoreRecipe({ store, sousVersion: "0.0.1" });
    expect(Object.keys(readIndex(root).recipes[CORE_RECIPE_KEY]!.versions)).toEqual([
      "0.0.1",
    ]);

    const report = await seedCoreRecipe({ store, sousVersion: SOUS_VERSION });

    expect(report.wroteIndex).toBe(true);
    expect(Object.keys(readIndex(root).recipes[CORE_RECIPE_KEY]!.versions)).toEqual([
      SOUS_VERSION,
    ]);
  });

  /**
   * The sidecar is what says when a cached index was fetched, and a stand-in was
   * not fetched at all. Leaving it out is what makes the very first command with
   * a network go and get the real index, instead of waiting out a freshness
   * window the stand-in never earned.
   */
  it("writes no sidecar, so the stand-in is never treated as fresh", async () => {
    const { store, root } = makeStore();
    const sidecar = `${indexPath(root).slice(0, -".json".length)}${INDEX_SIDECAR_SUFFIX}`;
    fs.mkdirSync(path.dirname(sidecar), { recursive: true });
    fs.writeFileSync(sidecar, JSON.stringify({ fetchedAt: new Date().toISOString() }));

    await seedCoreRecipe({ store, sousVersion: SOUS_VERSION });

    expect(fs.existsSync(sidecar)).toBe(false);
  });

  /**
   * Seeding is a convenience. A store it cannot write must be reported, never
   * thrown, so a build that may not even use recipes still runs.
   */
  it("reports a failure instead of throwing", async () => {
    const { store } = makeStore();
    const broken = {
      ...store,
      root: store.root,
      get: async () => undefined,
      put: async () => {
        throw new Error("the store is read only");
      },
    } as unknown as RecipeStore;

    const report = await seedCoreRecipe({ store: broken, sousVersion: SOUS_VERSION });

    expect(report.seeded).toBe(false);
    expect(report.skippedBecause).toContain("the store is read only");
  });
});

describe("coreIndexOverlay()", () => {
  const HASH = `sha256-${"b".repeat(64)}`;

  /** A real index for the official repository, publishing the versions given. */
  function realIndex(versions: string[]) {
    return parseIndexFile(
      {
        formatVersion: 1,
        name: OFFICIAL_REPO_NAME,
        generatedAt: "2026-01-01T00:00:00.000Z",
        generator: "0.1.1",
        namespaces: { core: { description: "The core skills." } },
        recipes: {
          [CORE_RECIPE_KEY]: {
            path: "recipes/core/sous-skills",
            description: "What the repository says about it.",
            versions: Object.fromEntries(
              versions.map((version) => [
                version,
                {
                  hash: `sha256-${"a".repeat(64)}`,
                  tag: `${CORE_RECIPE_KEY}@${version}`,
                  prerelease: false,
                },
              ])
            ),
          },
        },
      },
      "test"
    );
  }

  /**
   * The bug this exists for: a machine that has already fetched the real index
   * upgrades sous, and the repository has not published the new version yet.
   * Without the overlay nothing satisfies the built-in subscription's range and
   * the project quietly loses its core skills.
   */
  it("adds the packaged version when the published index lacks it", () => {
    const overlay = coreIndexOverlay({ version: "9.9.9", hash: HASH });

    const result = overlay(OFFICIAL_REPO_IDENTITY, realIndex(["0.1.1"]));

    const versions = result.recipes[CORE_RECIPE_KEY]!.versions;
    expect(Object.keys(versions).sort()).toEqual(["0.1.1", "9.9.9"]);
    expect(versions["9.9.9"]).toEqual({
      hash: HASH,
      tag: `${CORE_RECIPE_KEY}@9.9.9`,
      prerelease: false,
      seeded: true,
    });

    // What the repository published is untouched, and so is the index it was
    // read from.
    expect(versions["0.1.1"]!.seeded).toBeUndefined();
    expect(
      Object.keys(realIndex(["0.1.1"]).recipes[CORE_RECIPE_KEY]!.versions)
    ).toEqual(["0.1.1"]);
  });

  /** The result has to be something the index schema still accepts. */
  it("produces an index that still validates", () => {
    const overlay = coreIndexOverlay({ version: "9.9.9", hash: HASH });

    const result = overlay(OFFICIAL_REPO_IDENTITY, realIndex(["0.1.1"]));

    expect(() => parseIndexFile(result, "overlaid")).not.toThrow();
  });

  /** A prerelease version of sous seeds a prerelease of the recipe. */
  it("marks a prerelease version as one", () => {
    const overlay = coreIndexOverlay({ version: "9.9.9-rc.1", hash: HASH });

    const result = overlay(OFFICIAL_REPO_IDENTITY, realIndex(["0.1.1"]));

    expect(result.recipes[CORE_RECIPE_KEY]!.versions["9.9.9-rc.1"]!.prerelease).toBe(true);
  });

  /** Once the repository publishes the version, its own entry is what is used. */
  it("leaves a published version of its own alone", () => {
    const warnings: string[] = [];
    const overlay = coreIndexOverlay({
      version: "0.1.1",
      hash: `sha256-${"a".repeat(64)}`,
      warn: (message) => warnings.push(message),
    });

    const index = realIndex(["0.1.1"]);
    expect(overlay(OFFICIAL_REPO_IDENTITY, index)).toBe(index);
    expect(warnings).toEqual([]);
  });

  /**
   * Same version, different bytes. That should not happen, since both are built
   * from the same source; when it does, the published one wins and sous says so
   * exactly once.
   */
  it("prefers the published version and warns once when the hashes differ", () => {
    const warnings: string[] = [];
    const overlay = coreIndexOverlay({
      version: "0.1.1",
      hash: HASH,
      warn: (message) => warnings.push(message),
    });

    const first = overlay(OFFICIAL_REPO_IDENTITY, realIndex(["0.1.1"]));
    overlay(OFFICIAL_REPO_IDENTITY, realIndex(["0.1.1"]));

    expect(first.recipes[CORE_RECIPE_KEY]!.versions["0.1.1"]!.hash).toBe(
      `sha256-${"a".repeat(64)}`
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("different contents");
  });

  /** The overlay is about one repository, and says nothing about any other. */
  it("leaves every other repository's index alone", () => {
    const overlay = coreIndexOverlay({ version: "9.9.9", hash: HASH });
    const index = realIndex(["0.1.1"]);

    expect(overlay("github.com/someone/else", index)).toBe(index);
  });

  /**
   * A machine that has never fetched anything reads sous's own stand-in, which
   * already names the packaged version; there is nothing left to add.
   */
  it("adds nothing to the stand-in index the seed writes", async () => {
    const { store, root } = makeStore();
    const report = await seedCoreRecipe({ store, sousVersion: SOUS_VERSION });
    const overlay = coreIndexOverlay({ version: SOUS_VERSION, hash: report.hash! });

    const cached = readIndex(root);
    expect(overlay(OFFICIAL_REPO_IDENTITY, cached)).toBe(cached);
  });
});

describe("seedCoreRecipe() and the index cache", () => {
  /**
   * Seeding is where the packaged hash becomes known, so it is where the cache
   * is taught about it.
   */
  it("installs an overlay carrying the hash it seeded", async () => {
    const { store, root } = makeStore();
    let installed: IndexOverlay | undefined;

    const report = await seedCoreRecipe({
      store,
      sousVersion: SOUS_VERSION,
      indexCache: {
        setOverlay: (overlay) => {
          installed = overlay;
        },
      },
    });

    expect(installed).toBeDefined();

    const published = parseIndexFile(
      {
        formatVersion: 1,
        name: OFFICIAL_REPO_NAME,
        generatedAt: "2026-01-01T00:00:00.000Z",
        generator: "0.1.1",
        namespaces: { core: {} },
        recipes: {
          [CORE_RECIPE_KEY]: {
            path: "recipes/core/sous-skills",
            versions: {
              "0.0.1": {
                hash: `sha256-${"a".repeat(64)}`,
                tag: `${CORE_RECIPE_KEY}@0.0.1`,
                prerelease: false,
              },
            },
          },
        },
      },
      "test"
    );

    const overlaid = installed!(OFFICIAL_REPO_IDENTITY, published);
    expect(overlaid.recipes[CORE_RECIPE_KEY]!.versions[SOUS_VERSION]!.hash).toBe(
      report.hash
    );
    expect(root).toBe(store.root);
  });

  /** A store that cannot be written teaches the cache nothing. */
  it("installs no overlay when it could not seed", async () => {
    const { store } = makeStore();
    const broken = {
      ...store,
      root: store.root,
      get: async () => undefined,
      put: async () => {
        throw new Error("the store is read only");
      },
    } as unknown as RecipeStore;
    let installed = false;

    await seedCoreRecipe({
      store: broken,
      sousVersion: SOUS_VERSION,
      indexCache: {
        setOverlay: () => {
          installed = true;
        },
      },
    });

    expect(installed).toBe(false);
  });
});
