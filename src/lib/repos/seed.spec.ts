import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTmpDir, type TmpDir } from "../../test/utils/tmp.js";
import { SOUS_VERSION } from "../settings.js";
import { CORE_RECIPE_KEY, OFFICIAL_REPO_NAME } from "./core-recipe.js";
import { parseIndexFile } from "./formats/index-file.js";
import { INDEX_CACHE_DIRNAME, INDEX_SIDECAR_SUFFIX } from "./providers/index-cache.js";
import { RecipeStore } from "./store/recipe-store.js";
import { SEED_INDEX_COMMENT, seedCoreRecipe } from "./seed.js";

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
  return path.join(root, INDEX_CACHE_DIRNAME, `${OFFICIAL_REPO_NAME}.json`);
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
      repo: OFFICIAL_REPO_NAME,
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
      repo: OFFICIAL_REPO_NAME,
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
            "9.9.9": { hash: `sha256-${"a".repeat(64)}`, tag: "t", prerelease: false },
          },
        },
      },
    };
    fs.mkdirSync(path.join(root, INDEX_CACHE_DIRNAME), { recursive: true });
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
    const sidecar = path.join(
      root,
      INDEX_CACHE_DIRNAME,
      `${OFFICIAL_REPO_NAME}${INDEX_SIDECAR_SUFFIX}`
    );
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
