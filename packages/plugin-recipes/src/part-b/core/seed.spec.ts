import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nullReporter } from "@sous-io/plugin-api";
import { hashDirectorySync, indexFileFormat } from "@sous-io/plugin-formats";
import type { IndexFile, StoreEntry } from "@sous-io/plugin-formats/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RecipesStore, RepositoryHostContext, StoreKey } from "../../types.js";
import { CORE_RECIPE_KEY, OFFICIAL_REPO_IDENTITY } from "../constants.js";
import { IndexCacheCore } from "../index-cache/index-cache.js";
import { SEED_INDEX_COMMENT, seedCoreRecipe } from "./seed.js";

let dir: string;
let packaged: string;
let cache: IndexCacheCore;
let store: RecipesStore & { puts: number };

/** A store over a directory, enough for seeding. */
function fsStore(root: string): RecipesStore & { puts: number } {
    const entryDir = (key: StoreKey) => path.join(root, ...key.identity.split("/"), key.namespace, key.name, key.version);
    const entries = new Map<string, StoreEntry>();
    const id = (key: StoreKey) => entryDir(key);

    return {
        root,
        puts: 0,
        entryDir,
        async put(key, source) {
            this.puts += 1;
            fs.cpSync(source, entryDir(key), { recursive: true });
            const entry: StoreEntry = { formatVersion: 1, repo: key.identity, namespace: key.namespace, name: key.name, version: key.version, hash: hashDirectorySync(entryDir(key)), fetchedAt: "", lastAccessAt: "", sizeBytes: 0 };

            entries.set(id(key), entry);

            return entry;
        },
        async get(key) {
            const entry = entries.get(id(key));

            return entry === undefined ? undefined : { dir: entryDir(key), entry };
        },
        async has(key) {
            return entries.has(id(key));
        },
        async remove() {},
        async list() {
            return [...entries.values()];
        },
        async gc() {
            return { evicted: [], kept: [], bytesBefore: 0, bytesAfter: 0, dryRun: false };
        },
    };
}

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-"));
    packaged = path.join(dir, "package", "recipes", "core", "sous-skills");
    fs.mkdirSync(path.join(packaged, "skills"), { recursive: true });
    fs.writeFileSync(path.join(packaged, "sous.recipe.yaml"), "formatVersion: 1\nnamespace: core\nname: sous-skills\nversion: 0.2.34\ncontents: []\n", "utf8");
    fs.writeFileSync(path.join(packaged, "skills", "SKILL.md"), "# sous\n", "utf8");
    cache = new IndexCacheCore({
        directory: path.join(dir, "cache", "_indexes"),
        strategiesFile: path.join(dir, "cache", "read-strategies.json"),
        parser: indexFileFormat,
        hosts: () => [],
        hostContext: () => ({ reporter: nullReporter }) as unknown as RepositoryHostContext,
    });
    store = fsStore(path.join(dir, "cache"));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Seeds at a version. */
function seed(version = "0.2.34") {
    return seedCoreRecipe({ store, cache, version, packagedDir: packaged, description: "Core skills.", now: () => new Date("2026-10-29T00:00:00.000Z") });
}

describe("seedCoreRecipe", () => {
    it("should copy the packaged core recipe into an empty store", async () => {
        const report = await seed();

        expect(report).toMatchObject({ seeded: true, alreadyPresent: false, wroteIndex: true, version: "0.2.34" });
        expect(fs.existsSync(path.join(store.entryDir({ identity: OFFICIAL_REPO_IDENTITY, namespace: "core", name: "sous-skills", version: "0.2.34" }), "skills", "SKILL.md"))).toBe(true);
    });

    it("should write a valid stand-in index naming the seeded version with the hash it seeded, and no sidecar", async () => {
        fs.mkdirSync(path.dirname(cache.sidecarPath(OFFICIAL_REPO_IDENTITY)), { recursive: true });
        fs.writeFileSync(cache.sidecarPath(OFFICIAL_REPO_IDENTITY), "{}", "utf8");

        const report = await seed();
        const index = cache.readRaw(OFFICIAL_REPO_IDENTITY) as IndexFile;

        expect(index.$comment).toBe(SEED_INDEX_COMMENT);
        expect(index.recipes[CORE_RECIPE_KEY].versions["0.2.34"]).toMatchObject({ hash: report.hash, seeded: true });
        expect(index.recipes[CORE_RECIPE_KEY].description).toBe("Core skills.");
        expect(report.hash).toBe(hashDirectorySync(packaged));
        expect(fs.existsSync(cache.sidecarPath(OFFICIAL_REPO_IDENTITY))).toBe(false);
        expect(cache.isFresh(OFFICIAL_REPO_IDENTITY)).toBe(false);
    });

    it("should do nothing on a second run", async () => {
        await seed();
        const text = fs.readFileSync(cache.indexPath(OFFICIAL_REPO_IDENTITY), "utf8");
        const report = await seed();

        expect(report).toMatchObject({ seeded: false, alreadyPresent: true, wroteIndex: false });
        expect(store.puts).toBe(1);
        expect(fs.readFileSync(cache.indexPath(OFFICIAL_REPO_IDENTITY), "utf8")).toBe(text);
    });

    it("should leave a real cached index alone, and teach the cache the packaged version through the overlay", async () => {
        const real: IndexFile = { formatVersion: 1, name: "sous-recipes", generatedAt: "2026-10-01T00:00:00.000Z", generator: "0.2.33", namespaces: {}, recipes: {} };

        cache.writeIndex(OFFICIAL_REPO_IDENTITY, real);

        const report = await seed();

        expect(report.wroteIndex).toBe(false);
        expect(cache.readRaw(OFFICIAL_REPO_IDENTITY)?.recipes[CORE_RECIPE_KEY]).toBeUndefined();
        expect(cache.readCached(OFFICIAL_REPO_IDENTITY)?.recipes[CORE_RECIPE_KEY].versions["0.2.34"]).toMatchObject({ hash: report.hash, seeded: true });
    });

    it("should replace its own stand-in when the version it seeds has changed", async () => {
        await seed("0.2.33");
        const report = await seed("0.2.34");
        const index = cache.readRaw(OFFICIAL_REPO_IDENTITY) as IndexFile;

        expect(report.wroteIndex).toBe(true);
        expect(Object.keys(index.recipes[CORE_RECIPE_KEY].versions)).toEqual(["0.2.34"]);
    });

    it("should replace a cached copy that no longer parses", async () => {
        fs.mkdirSync(path.dirname(cache.indexPath(OFFICIAL_REPO_IDENTITY)), { recursive: true });
        fs.writeFileSync(cache.indexPath(OFFICIAL_REPO_IDENTITY), "garbage", "utf8");

        expect((await seed()).wroteIndex).toBe(true);
    });

    it("should report, not throw, when the package lacks the recipe", async () => {
        const report = await seedCoreRecipe({ store, cache, version: "0.2.34", packagedDir: undefined });

        expect(report.seeded).toBe(false);
        expect(report.skippedBecause).toMatch(/missing the core recipe/);
    });

    it("should report, not throw, when the store fails, installing no overlay", async () => {
        store.put = async () => Promise.reject(new Error("read-only file system"));

        const report = await seed();

        expect(report.skippedBecause).toMatch(/could not seed the core recipe.*read-only file system/);
        cache.writeIndex(OFFICIAL_REPO_IDENTITY, { formatVersion: 1, name: "sous-recipes", generatedAt: "x", generator: "x", namespaces: {}, recipes: {} });
        expect(cache.readCached(OFFICIAL_REPO_IDENTITY)?.recipes[CORE_RECIPE_KEY]).toBeUndefined();
    });
});
