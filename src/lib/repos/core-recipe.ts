/**
 * The core recipe that ships inside the sous package.
 *
 * One namespace is special: `core`, the skills that teach an agent what sous is
 * and how it works. Every project gets it, and a project that has never seen a
 * network must still get it, so a copy of the recipe lives in the package at
 * `recipes/core/sous-skills/` and seeds the machine-wide store on first run.
 *
 * Two rules hold this arrangement together:
 *
 *   - VERSION PARITY. The packaged recipe's version is always exactly the
 *     version of the sous package shipping it, and the implicit `core`
 *     subscription's range is exactly the running sous version. Core therefore
 *     always matches the CLI, and upgrading sous upgrades core with it.
 *     `core-recipe.spec.ts` enforces the first half of that rule; the release
 *     pipeline (`.github/workflows/publish-recipes.yml`) enforces it again at
 *     publish time.
 *   - NO DEPENDENCIES. The packaged copy is the offline seed, so nothing in it
 *     may point at a recipe that has to be fetched.
 *
 * The same recipe is also published by the official repository, so an online
 * project resolves it exactly like any other recipe; the package copy is a seed,
 * not a private fork.
 */

import path from "node:path";
import { CLI_ROOT, SOUS_VERSION } from "../settings.js";
import { ConfigError } from "../errors.js";
import { findRecipeManifest, loadManifestFile } from "./load-manifest.js";
import { parseRecipeManifest, type RecipeManifest } from "./formats/recipe-manifest.js";

/** The directory inside the package that holds every recipe sous ships. */
export const PACKAGED_RECIPES_DIRNAME = "recipes";

/** The short name the official repository is recorded under in every project. */
export const OFFICIAL_REPO_NAME = "sous-recipes";

/** Where the official repository lives. */
export const OFFICIAL_REPO_URL = "https://github.com/sous-io/sous-recipes";

/** The provider that handles the official repository. */
export const OFFICIAL_REPO_PROVIDER = "github";

/** The namespace every project is subscribed to unless it opts out. */
export const CORE_NAMESPACE = "core";

/** The name of the recipe published in that namespace. */
export const CORE_RECIPE_NAME = "sous-skills";

/** The core recipe's key, `core/sous-skills`. */
export const CORE_RECIPE_KEY = `${CORE_NAMESPACE}/${CORE_RECIPE_NAME}`;

/** The core recipe's folder, relative to the repository root, as the index records it. */
export const CORE_RECIPE_PATH = `${PACKAGED_RECIPES_DIRNAME}/${CORE_NAMESPACE}/${CORE_RECIPE_NAME}`;

/**
 * The directory holding the packaged copy of the core recipe.
 *
 * @param packageRoot - The installed package's root directory. Defaults to the
 *   running CLI's own root, which is what every caller outside a test wants.
 */
export function packagedCoreRecipeDir(packageRoot: string = CLI_ROOT): string {
  return path.join(packageRoot, PACKAGED_RECIPES_DIRNAME, CORE_NAMESPACE, CORE_RECIPE_NAME);
}

/**
 * Reads and validates the packaged core recipe's manifest.
 *
 * A missing or unreadable manifest is a broken installation rather than a user
 * mistake, so the error says so plainly instead of suggesting a fix the user
 * cannot make.
 *
 * @param packageRoot - The installed package's root directory.
 */
export function readPackagedCoreManifest(packageRoot: string = CLI_ROOT): RecipeManifest {
  const dir = packagedCoreRecipeDir(packageRoot);
  const manifestPath = findRecipeManifest(dir);

  if (manifestPath === undefined) {
    throw new ConfigError(
      `This installation of sous is missing the core recipe it ships with.\n` +
        `  Sous expected to find a recipe manifest in ${dir}.\n` +
        `  Reinstalling the sous package will restore it.`
    );
  }

  return parseRecipeManifest(loadManifestFile(manifestPath), manifestPath);
}

/**
 * The version of the core recipe this installation seeds, which is by rule the
 * version of sous itself. Read from the constant rather than from the manifest
 * so a damaged package cannot quietly seed a version that does not match the
 * CLI; the parity test proves the two agree.
 */
export function coreRecipeVersion(): string {
  return SOUS_VERSION;
}
