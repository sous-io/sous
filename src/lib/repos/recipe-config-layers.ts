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
 * A recipe layer is JSON (`.json`, or `.jsonc` for JSON with comments) or YAML
 * only. The config kernel would happily import a
 * `.js` layer, and a repository's whole trust story rests on sous being able to
 * read what it publishes without running any of it, so an executable layer from
 * a recipe is refused rather than loaded.
 *
 * A recipe layer is also read HERE rather than by the config kernel, and only
 * the keys on the allowlist below survive the reading. A recipe is content you
 * subscribed to; it does not get to decide what sous trusts or what sous runs.
 * See RECIPE_CONFIG_ALLOWED_KEYS.
 */

import fs from "node:fs";
import path from "node:path";
import { globSync } from "glob";
import { parse as parseYaml } from "yaml";
import { parseJsoncText } from "./load-manifest.js";
import { listLockedRecipes, readRecipeManifestIn } from "./locked-recipes.js";

/** The layer extensions a recipe may contribute; the executable ones are refused. */
export const RECIPE_LAYER_EXTENSIONS = [".json", ".jsonc", ".yaml", ".yml"] as const;

/** Extensions sous can load as a config layer but deliberately will not take from a recipe. */
export const RECIPE_LAYER_EXECUTABLE_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts"] as const;

/**
 * The only top-level config keys a recipe's config layer may set.
 *
 * A recipe layer is merged into the project's configuration, so without this
 * allowlist a recipe could add a repository to `repos:` (granting itself, and
 * anything published beside it, trust the person never gave), add a
 * subscription, or point a `tools.<name>.command` at a program that `sous
 * launch` then spawns. Every key here is inert with respect to trust and to
 * what sous executes: a recipe can supply variables, aliases, compilation
 * targets, runtime context, where recipe output lands, store knobs and variable
 * mappings, and nothing else.
 *
 * Anything not on this list is dropped with a warning naming the recipe and the
 * key, including keys sous does not recognise at all.
 */
export const RECIPE_CONFIG_ALLOWED_KEYS = [
  "_aliases",
  "_vars",
  "compilation",
  "recipeOutputs",
  "runtimeContext",
  "store",
  "varMappings",
] as const;

/**
 * Plain-language reasons for the refused keys a recipe is most likely to try,
 * so the warning says why rather than only that.
 */
const REFUSAL_REASONS: Record<string, string> = {
  repos:
    "only you decide which repositories this project trusts, so a recipe may not add one",
  subscriptions:
    "only you decide what this project subscribes to, so a recipe may not subscribe on your behalf",
  tools:
    "a tool entry names a program sous launches, so a recipe may not add one or change one",
  _env: "an _env mapping decides which environment variables reach the build",
  version: "the config version is the project's own to declare",
  name: "the project's display name is the project's own to declare",
  $schema: "the schema binding is the project's own editor setting",
};

/** One recipe config layer, already read and already filtered. */
export type RecipeConfigLayer = {
  /** Absolute path of the file it was read from, used for reporting and tracing. */
  path: string;
  /** The `namespace/recipe` key of the recipe that contributed it. */
  recipeKey: string;
  /** The layer's content, with every key outside the allowlist removed. */
  config: Record<string, unknown>;
};

/** What a recipe's config contents came to. */
export type RecipeConfigLayers = {
  /** The layers, in the order they should be merged. */
  layers: RecipeConfigLayer[];
  /** Absolute paths of those layers, in the same order. */
  paths: string[];
  /** Complete, plain-language sentences about anything that was skipped. */
  warnings: string[];
};

/**
 * Removes every top-level key a recipe is not allowed to set.
 *
 * Pure, so the rule can be tested on its own: give it whatever a layer file
 * parsed to and it returns what may be merged, plus a sentence for everything
 * it took out.
 *
 * @param recipeKey - The `namespace/recipe` key, named in every warning.
 * @param layerPath - The layer file, named in every warning.
 * @param raw - Whatever the layer file parsed to.
 */
export function filterRecipeConfigLayer(
  recipeKey: string,
  layerPath: string,
  raw: unknown
): { config: Record<string, unknown>; warnings: string[] } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      config: {},
      warnings: [
        `The recipe ${recipeKey} contributes a config layer that is not a set of ` +
          `configuration keys, so none of it was merged:\n  ${layerPath}\n` +
          `A config layer has to be an object with configuration keys at its top level.`,
      ],
    };
  }

  const warnings: string[] = [];
  const allowed = new Set<string>(RECIPE_CONFIG_ALLOWED_KEYS);
  const config: Record<string, unknown> = {};

  for (const key of Object.keys(raw)) {
    if (allowed.has(key)) {
      config[key] = (raw as Record<string, unknown>)[key];
      continue;
    }
    const reason =
      REFUSAL_REASONS[key] ?? "sous does not recognise it as a key a recipe may set";
    warnings.push(
      `The recipe ${recipeKey} tried to set '${key}' in a config layer, and sous ` +
        `removed it before merging anything:\n  ${layerPath}\n` +
        `That key is not one a recipe may set (${reason}). A recipe's config layer may ` +
        `set only: ${RECIPE_CONFIG_ALLOWED_KEYS.join(", ")}.`
    );
  }

  return { config, warnings };
}

/**
 * Every config layer the recipes this project subscribes to contribute, read
 * and filtered, ordered by recipe key and then by path so the merge order is
 * the same on every machine.
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
  const result: RecipeConfigLayers = { layers: [], paths: [], warnings: [] };

  let locked;
  try {
    locked = listLockedRecipes({ sousDir, env });
  } catch {
    // Config discovery runs before anything can report a problem nicely. A
    // lockfile that does not parse is reported by every other reader of it, so
    // contributing no layers here is the quiet, correct answer.
    return result;
  }

  const executable: string[] = [];
  const unsupported: string[] = [];

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
          if (
            (RECIPE_LAYER_EXECUTABLE_EXTENSIONS as readonly string[]).includes(extension)
          ) {
            executable.push(filePath);
            continue;
          }
          if (!(RECIPE_LAYER_EXTENSIONS as readonly string[]).includes(extension)) {
            unsupported.push(filePath);
            continue;
          }
          found.push(path.normalize(filePath));
        }
      }
    }

    for (const layerPath of [...new Set(found)].sort()) {
      let raw: unknown;
      try {
        raw = readLayerFile(layerPath);
      } catch (error) {
        result.warnings.push(
          `The recipe ${recipe.key} contributes a config layer sous could not read, so ` +
            `none of it was merged:\n  ${layerPath}\n` +
            `${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }

      const filtered = filterRecipeConfigLayer(recipe.key, layerPath, raw);
      result.warnings.push(...filtered.warnings);
      result.layers.push({
        path: layerPath,
        recipeKey: recipe.key,
        config: filtered.config,
      });
      result.paths.push(layerPath);
    }
  }

  if (executable.length > 0) {
    result.warnings.push(
      `Some subscribed recipes contribute config layers that are program code, and sous ` +
        `refused to load them:\n` +
        executable.map((entry) => `  ${entry}`).join("\n") +
        `\nSous must be able to read everything a repository publishes without running ` +
        `any of it, so an executable layer from a recipe is never loaded. Publish the ` +
        `same settings as ${RECIPE_LAYER_EXTENSIONS.join(", ")} instead.`
    );
  }

  if (unsupported.length > 0) {
    result.warnings.push(
      `Some subscribed recipes contribute config layers written in a format sous does ` +
        `not read, and they were skipped:\n` +
        unsupported.map((entry) => `  ${entry}`).join("\n") +
        `\nA recipe's config layer is written as ${RECIPE_LAYER_EXTENSIONS.join(", ")}.`
    );
  }

  return result;
}

/** Reads and parses one recipe config layer according to its extension. */
function readLayerFile(layerPath: string): unknown {
  const text = fs.readFileSync(layerPath, "utf8");
  const extension = path.extname(layerPath).toLowerCase();
  if (extension === ".jsonc") return parseJsoncText(text, layerPath);
  if (extension === ".json") return JSON.parse(text);
  return parseYaml(text);
}

/** True when the path is a regular file. */
function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
