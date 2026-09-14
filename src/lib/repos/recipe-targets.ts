/**
 * Turning subscribed recipes into compile targets.
 *
 * A recipe's manifest lists what it contributes: skills, memories, prompts and
 * config layers. Everything but the config layers is compiled exactly the way a
 * project's own `entryGlob` target is: the recipe's directory is the glob root,
 * the static part of each include pattern is the base the output tree mirrors,
 * and the `.tpl.` convention applies unchanged. Nothing about a recipe's files
 * is special once they are on disk.
 *
 * Two rules decide what is compiled at all:
 *
 *   - Only recipes held through `subscribes` contribute files. A recipe held
 *     only through `depends` is fetched, pinned and addressable from the recipe
 *     that declared it, but its files never enter the project's output; that is
 *     the whole difference between the two dependency kinds.
 *   - A content kind with nowhere to go is skipped, with ONE warning naming the
 *     `recipeOutputs` config key. Only `skills` has a default, because
 *     `.claude/skills` is where every agent looks; sous cannot guess where a
 *     project wants its memories or its prompts.
 *
 * A recipe's `config` contents are not handled here. They are config layers, and
 * config layers are loaded before any of this runs; see
 * `listRecipeConfigLayers` in `config-discovery.ts`.
 */

import fs from "node:fs";
import path from "node:path";
import { globSync } from "glob";
import type { CompilationTarget } from "../markdown-compiler.js";
import { inferGlobBase } from "../markdown-compiler.js";
import type { Settings, VarScope } from "../settings.js";
import { normalizeConfigPath, substituteVarsStrict } from "../settings.js";
import type { ContentKind } from "./formats/recipe-manifest.js";
import {
  listLockedRecipes,
  readRecipeManifestIn,
  type LockedRecipeLocation,
} from "./locked-recipes.js";

/** The content kinds that produce files in a project. `config` is a layer, not a file. */
export const WRITABLE_CONTENT_KINDS = ["skills", "memories", "prompts"] as const;

/** One content kind whose files land somewhere in the project. */
export type WritableContentKind = (typeof WRITABLE_CONTENT_KINDS)[number];

/** How the recipe targets are built. */
export type RecipeTargetOptions = {
  /** The project's `.sous/` directory. */
  sousDir: string;
  /** The merged project config, read for `recipeOutputs`. */
  settings: Settings;
  /** The resolved settings scope, used to substitute `${var}` in destinations. */
  scope?: VarScope;
  /**
   * The scope one recipe's own files render with. A recipe's answers to its own
   * questions are laid over the project scope there, so a recipe sees its own
   * answer even when another recipe asks the same name. Defaults to `scope`.
   */
  scopeFor?: (recipe: LockedRecipeLocation) => VarScope;
  /** The environment to read; decides where the store is. */
  env?: NodeJS.ProcessEnv;
  /** The locked recipes, when the caller has already located them. */
  locked?: LockedRecipeLocation[];
};

/** What the recipe targets add to a build. */
export type RecipeTargets = {
  /** One compile target per file a subscribed recipe contributes. */
  targets: CompilationTarget[];
  /** Every destination directory the targets write into, for prune's benefit. */
  destinations: string[];
  /** Directories a watch should follow: the linked checkouts contributing files. */
  watchDirs: string[];
  /** Complete, plain-language sentences a build should print before it compiles. */
  warnings: string[];
};

/**
 * The project's root directory: the parent of its `.sous/` directory. Used only
 * for the one destination sous defaults, `.claude/skills`.
 *
 * @param sousDir - The project's `.sous/` directory.
 */
export function projectRootFor(sousDir: string): string {
  return path.dirname(path.resolve(sousDir));
}

/**
 * Where one content kind's files are written, with `${var}` substituted and each
 * path normalized. An empty list means "nowhere configured", which is what makes
 * the caller warn and skip.
 *
 * @param kind - The content kind.
 * @param options - The project's config, scope and `.sous/` directory.
 */
export function destinationsFor(
  kind: WritableContentKind,
  options: RecipeTargetOptions
): string[] {
  const configured = options.settings.recipeOutputs?.[kind];

  if (configured === undefined || configured.length === 0) {
    // `.claude/skills` is where every agent looks, so it is worth defaulting.
    // Nothing else has an obvious home.
    return kind === "skills"
      ? [path.join(projectRootFor(options.sousDir), ".claude", "skills")]
      : [];
  }

  return configured.map((destination, index) =>
    normalizeConfigPath(
      substituteVarsStrict(
        destination,
        options.scope ?? {},
        `recipeOutputs.${kind}[${index}]`
      )
    )
  );
}

/**
 * Builds the compile targets that the recipes this project subscribes to
 * contribute. Returns an empty result for a project that locks nothing, so a
 * project using no repositories pays nothing for this.
 *
 * @param options - The project's `.sous/` directory, its config and its scope.
 */
export function buildRecipeTargets(options: RecipeTargetOptions): RecipeTargets {
  const locked =
    options.locked ??
    listLockedRecipes({
      sousDir: options.sousDir,
      ...(options.env === undefined ? {} : { env: options.env }),
    });

  const result: RecipeTargets = {
    targets: [],
    destinations: [],
    watchDirs: [],
    warnings: [],
  };
  if (locked.length === 0) return result;

  const destinationCache = new Map<WritableContentKind, string[]>();
  const kindsWithNowhereToGo = new Set<WritableContentKind>();
  const destinations = new Set<string>();
  const watchDirs = new Set<string>();

  for (const recipe of locked) {
    // Only a co-subscription contributes files; a build dependency is fetched
    // and addressable, and that is all.
    if (recipe.kind !== "subscribes") continue;
    if (!recipe.present) continue;

    const manifest = readRecipeManifestIn(recipe.dir);
    if (manifest === undefined) continue;

    for (const content of manifest.contents) {
      const kind = content.kind;
      if (!isWritableKind(kind)) continue;

      if (!destinationCache.has(kind)) {
        destinationCache.set(kind, destinationsFor(kind, options));
      }
      const kindDestinations = destinationCache.get(kind)!;

      if (kindDestinations.length === 0) {
        kindsWithNowhereToGo.add(kind);
        continue;
      }

      for (const destination of kindDestinations) destinations.add(destination);
      if (recipe.linked) watchDirs.add(recipe.dir);

      const recipeScope = options.scopeFor?.(recipe) ?? options.scope ?? {};

      const ignore = (content.exclude ?? []).map((pattern) =>
        path.join(recipe.dir, pattern)
      );

      for (const include of content.include) {
        const pattern = path.join(recipe.dir, include);
        const matched = globSync(pattern, { absolute: true, ignore }).filter(isFile);
        const globBase = normalizeConfigPath(inferGlobBase(pattern));

        for (const filePath of matched) {
          result.targets.push({
            rootInputPath: filePath,
            globBase,
            outputs: kindDestinations.map((destination) => ({
              destinationDir: destination,
              vars: recipeScope,
            })),
          });
        }
      }
    }
  }

  if (kindsWithNowhereToGo.size > 0) {
    const kinds = [...kindsWithNowhereToGo].sort();
    result.warnings.push(
      `Some subscribed recipes contribute ${kinds.join(" and ")} files, and this ` +
        `project has nowhere to put them, so they were skipped.\n` +
        `Name a destination directory for each kind under the 'recipeOutputs' key of ` +
        `your sous config, for example:\n` +
        `  recipeOutputs: { ${kinds
          .map((kind) => `${kind}: ["\${projectRoot}/${kind}"]`)
          .join(", ")} }`
    );
  }

  result.destinations = [...destinations].sort();
  result.watchDirs = [...watchDirs].sort();
  return result;
}

/** True when a content kind produces files rather than a config layer. */
function isWritableKind(kind: ContentKind): kind is WritableContentKind {
  return (WRITABLE_CONTENT_KINDS as readonly string[]).includes(kind);
}

/** True when the path is a regular file. */
function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
