import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { indexFileFormat } from "@sous-io/plugin-formats";
import type { IndexFile } from "@sous-io/plugin-formats/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { CORE_RECIPE_KEY, OFFICIAL_REPO_IDENTITY, OFFICIAL_REPO_PROVIDER, OFFICIAL_REPO_URL } from "../constants.js";
import { builtInCoreSubscription, builtInRepoEntry, coreIndexOverlay, isBuiltInEntry, packagedCoreRecipeDir } from "./core-recipe.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../../..");
const PACKAGED = path.join(REPO_ROOT, "recipes", "core", "sous-skills");
const HASH = `sha256-${"b".repeat(64)}` as const;
const made: string[] = [];

afterEach(() => {
    for (const dir of made.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/** An official index publishing these core versions. */
function officialIndex(versions: Record<string, string> = {}): IndexFile {
    return {
        formatVersion: 1,
        name: "sous-recipes",
        generatedAt: "2026-10-01T00:00:00.000Z",
        generator: "0.2.33",
        namespaces: {},
        recipes:
            Object.keys(versions).length === 0
                ? {}
                : {
                      [CORE_RECIPE_KEY]: {
                          path: "recipes/core/sous-skills",
                          versions: Object.fromEntries(Object.entries(versions).map(([version, hash]) => [version, { hash: hash as typeof HASH, tag: `${CORE_RECIPE_KEY}@${version}`, prerelease: false }])),
                      },
                  },
    };
}

describe("the packaged core recipe", () => {
    const manifest = parse(fs.readFileSync(path.join(PACKAGED, "sous.recipe.yaml"), "utf8")) as Record<string, unknown>;

    it("should ship at exactly the version of the sous package", () => {
        const version = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../../package.json"), "utf8")).version;

        expect(manifest.version).toBe(version);
    });

    it("should be core/sous-skills, with no dependencies, contributing skills", () => {
        expect(`${manifest.namespace}/${manifest.name}`).toBe(CORE_RECIPE_KEY);
        expect(manifest.depends ?? []).toEqual([]);
        expect(manifest.subscribes ?? []).toEqual([]);
        expect((manifest.contents as Array<{ kind: string }>).some((content) => content.kind === "skills")).toBe(true);
    });
});

describe("packagedCoreRecipeDir", () => {
    it("should find the recipe under the package root", () => {
        expect(packagedCoreRecipeDir(REPO_ROOT)).toBe(PACKAGED);
    });

    it("should look up to three parents above the package root", () => {
        expect(packagedCoreRecipeDir(path.join(REPO_ROOT, "packages", "sous"))).toBe(PACKAGED);
    });

    it("should give undefined when no parent holds it", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-core-"));

        made.push(dir);

        expect(packagedCoreRecipeDir(path.join(dir, "a", "b", "c", "d", "e"))).toBeUndefined();
    });
});

describe("the built-in entries", () => {
    it("should point the built-in repository at the official one, marked as sous's own", () => {
        expect(builtInRepoEntry()).toEqual({ url: OFFICIAL_REPO_URL, provider: OFFICIAL_REPO_PROVIDER, addedBy: "sous" });
        expect(isBuiltInEntry(builtInRepoEntry())).toBe(true);
        expect(isBuiltInEntry({ addedBy: "user" })).toBe(false);
    });

    it("should pin the core subscription to exactly the running version", () => {
        expect(builtInCoreSubscription("0.2.34")).toEqual({ range: "0.2.34", addedBy: "sous" });
    });
});

describe("coreIndexOverlay", () => {
    it("should add the packaged version, marked seeded, when the published index lacks it, and the result still validates", () => {
        const overlaid = coreIndexOverlay({ version: "0.2.34", hash: HASH, description: "Core." })(OFFICIAL_REPO_IDENTITY, officialIndex({ "0.2.33": HASH }));

        expect(overlaid.recipes[CORE_RECIPE_KEY].versions["0.2.34"]).toEqual({ hash: HASH, tag: `${CORE_RECIPE_KEY}@0.2.34`, prerelease: false, seeded: true });
        expect(overlaid.recipes[CORE_RECIPE_KEY].versions["0.2.33"]).toBeDefined();
        expect(overlaid.namespaces.core).toBeDefined();
        expect(() => indexFileFormat.parse(overlaid, "overlaid")).not.toThrow();
    });

    it("should add the recipe to an index that publishes none of it", () => {
        const overlaid = coreIndexOverlay({ version: "0.2.34", hash: HASH, description: "Core." })(OFFICIAL_REPO_IDENTITY, officialIndex());

        expect(overlaid.recipes[CORE_RECIPE_KEY]).toMatchObject({ path: "recipes/core/sous-skills", description: "Core." });
    });

    it("should mark a prerelease version as one", () => {
        const overlaid = coreIndexOverlay({ version: "1.0.0-beta.1", hash: HASH })(OFFICIAL_REPO_IDENTITY, officialIndex());

        expect(overlaid.recipes[CORE_RECIPE_KEY].versions["1.0.0-beta.1"].prerelease).toBe(true);
    });

    it("should leave a published version with the same hash alone", () => {
        const index = officialIndex({ "0.2.34": HASH });

        expect(coreIndexOverlay({ version: "0.2.34", hash: HASH })(OFFICIAL_REPO_IDENTITY, index)).toBe(index);
    });

    it("should prefer the published version and say so once when the hashes differ", () => {
        const onMismatch = vi.fn();
        const other = `sha256-${"c".repeat(64)}`;
        const overlay = coreIndexOverlay({ version: "0.2.34", hash: HASH, onMismatch });
        const index = officialIndex({ "0.2.34": other });

        expect(overlay(OFFICIAL_REPO_IDENTITY, index)).toBe(index);
        overlay(OFFICIAL_REPO_IDENTITY, index);

        expect(onMismatch).toHaveBeenCalledTimes(1);
        expect(onMismatch).toHaveBeenCalledWith(other, HASH);
    });

    it("should leave every other repository's index alone, and add nothing while the hash is unknown", () => {
        const index = officialIndex();

        expect(coreIndexOverlay({ version: "0.2.34", hash: HASH })("github.com/acme/other", index)).toBe(index);
        expect(coreIndexOverlay({ version: "0.2.34", hash: () => undefined })(OFFICIAL_REPO_IDENTITY, index)).toBe(index);
    });
});
