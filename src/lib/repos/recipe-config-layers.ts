/**
 * Config layers that come from subscribed recipes.
 *
 * A recipe may contribute `config` content: files that are merged into the
 * subscribing project's configuration rather than written anywhere in it. They
 * are loaded AFTER the primary config and BEFORE the `conf.d/` drop-ins, so a
 * recipe can supply defaults and the project always wins over them.
 *
 * This has to work before variable resolution, and before the settings even
 * exist, because these layers are part of what the settings are built from. It
 * therefore reads nothing but the lockfile, the links map and the store, all of
 * which are locatable from the `.sous/` directory and the environment alone.
 *
 * A recipe layer is JSON or YAML only. The config kernel would happily import a
 * `.js` layer, and a repository's whole trust story rests on sous being able to
 * read what it publishes without running any of it, so an executable layer from
 * a recipe is refused rather than loaded.
 */

import fs from "node:fs";
import path from "node:path";
import { globSync } from "glob";
import { listLockedRecipes, readRecipeManifestIn } from "./locked-recipes.js";

/** The layer extensions a recipe may contribute; the executable ones are refused. */
export const RECIPE_LAYER_EXTENSIONS = [".json", ".yaml"] as const;

/** What a recipe's config contents came to. */
export type RecipeConfigLayers = {
  /** Absolute paths of the layer files, in the order they should be merged. */
  layers: string[];
  /** Complete, plain-language sentences about anything that was skipped. */
  warnings: string[];
};

/**
 * Every config layer the recipes this project subscribes to contribute, ordered
 * by recipe key and then by path so the merge order is the same on every
 * machine.
 *
 * Only recipes held through `subscribes` contribute; a build dependency is
 * addressable from the recipe that declared it and changes nothing about the
 * project, its configuration included.
 *
 * @param sousDir - The project's `.sous/` directory.
 * @param env - The environment to read; decides where the store is.
 */
export function listRecipeConfigLayers(
  sousDir: string,
  env: NodeJS.ProcessEnv = process.env
): RecipeConfigLayers {
  const result: RecipeConfigLayers = { layers: [], warnings: [] };

  let locked;
  try {
    locked = listLockedRecipes({ sousDir, env });
  } catch {
    // Config discovery runs before anything can report a problem nicely. A
    // lockfile that does not parse is reported by every other reader of it, so
    // contributing no layers here is the quiet, correct answer.
    return result;
  }

  const refused: string[] = [];

  for (const recipe of locked) {
    if (recipe.kind !== "subscribes") continue;
    if (!recipe.present) continue;

    let manifest;
    try {
      manifest = readRecipeManifestIn(recipe.dir);
    } catch {
      continue;
    }
    if (manifest === undefined) continue;

    const found: string[] = [];

    for (const content of manifest.contents) {
      if (content.kind !== "config") continue;

      const ignore = (content.exclude ?? []).map((pattern) =>
        path.join(recipe.dir, pattern)
      );

      for (const include of content.include) {
        for (const filePath of globSync(path.join(recipe.dir, include), {
          absolute: true,
          ignore,
        })) {
          if (!isFile(filePath)) continue;
          const extension = path.extname(filePath).toLowerCase();
          if (!(RECIPE_LAYER_EXTENSIONS as readonly string[]).includes(extension)) {
            refused.push(filePath);
            continue;
          }
          found.push(path.normalize(filePath));
        }
      }
    }

    result.layers.push(...[...new Set(found)].sort());
  }

  if (refused.length > 0) {
    result.warnings.push(
      `Some subscribed recipes contribute config layers sous will not load, and they ` +
        `were skipped:\n` +
        refused.map((entry) => `  ${entry}`).join("\n") +
        `\nA recipe's config layer is written as ` +
        `${RECIPE_LAYER_EXTENSIONS.join(" or ")}. Sous must be able to read everything a ` +
        `repository publishes without running any of it, so an executable layer from a ` +
        `recipe is never loaded.`
    );
  }

  return result;
}

/** True when the path is a regular file. */
function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
