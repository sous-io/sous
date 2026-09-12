/**
 * Version parity between the packaged core recipe and the sous package itself.
 *
 * This is a hard rule of the design, not a convention: the `core` namespace is
 * auto-subscribed in every project at a range of exactly the running sous
 * version, so a packaged recipe whose version does not match the package would
 * be unresolvable the moment it was seeded. Bumping the package version means
 * bumping `recipes/core/sous-skills/sous.recipe.yaml` in the same commit, and
 * this test is what says so out loud.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_ROOT } from "../settings.js";
import {
  CORE_NAMESPACE,
  CORE_RECIPE_KEY,
  CORE_RECIPE_NAME,
  CORE_RECIPE_PATH,
  packagedCoreRecipeDir,
  readPackagedCoreManifest,
} from "./core-recipe.js";

/** The version this installation of sous publishes, read from package.json. */
function packageVersion(): string {
  const raw = fs.readFileSync(path.join(CLI_ROOT, "package.json"), "utf8");
  return (JSON.parse(raw) as { version: string }).version;
}

describe("the packaged core recipe", () => {
  it("ships at exactly the version of the sous package", () => {
    const manifest = readPackagedCoreManifest();
    expect(manifest.version).toBe(packageVersion());
  });

  it("is the recipe the rest of sous expects it to be", () => {
    const manifest = readPackagedCoreManifest();
    expect(manifest.namespace).toBe(CORE_NAMESPACE);
    expect(manifest.name).toBe(CORE_RECIPE_NAME);
    expect(`${manifest.namespace}/${manifest.name}`).toBe(CORE_RECIPE_KEY);
  });

  it("declares no dependencies, because it is the offline seed", () => {
    const manifest = readPackagedCoreManifest();
    expect(manifest.depends ?? []).toEqual([]);
    expect(manifest.subscribes ?? []).toEqual([]);
  });

  it("lives where the packaged path constant says it does", () => {
    expect(packagedCoreRecipeDir()).toBe(path.join(CLI_ROOT, CORE_RECIPE_PATH));
    expect(fs.existsSync(packagedCoreRecipeDir())).toBe(true);
  });

  it("contributes skills, which is what a project compiles from it", () => {
    const manifest = readPackagedCoreManifest();
    const kinds = manifest.contents.map((content) => content.kind);
    expect(kinds).toContain("skills");
  });

  it("is listed in the files the npm package ships", () => {
    const raw = fs.readFileSync(path.join(CLI_ROOT, "package.json"), "utf8");
    const files = (JSON.parse(raw) as { files: string[] }).files;
    expect(files).toContain("recipes");
  });
});
