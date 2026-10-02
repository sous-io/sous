/**
 * The memories the project's active recipes publish, listed for the `#memories`
 * view and for the build's check that every one of them reached an output.
 *
 * A recipe is ACTIVE when the project holds it directly or a co-subscription
 * does (its lockfile kind is `subscribes`); a recipe held only through
 * `depends` is a library and contributes nothing. A memory is a file matched by
 * an include pattern of a manifest `contents` entry of `kind: memories`, and its
 * virtual path is `<namespace>/<recipe>/<path>`, the path being relative to the
 * static base of that pattern.
 *
 * Order: a recipe comes after every pinned recipe it depends on or subscribes
 * to, ties go to the recipe key (bytewise), and the recipes matching
 * `recipes.memories.first` move to the front in that same relative order. Within
 * a recipe, files are in bytewise path order. Recipes matching
 * `recipes.memories.exclude` are not listed.
 */

import fs from "node:fs";
import path from "node:path";
import { globSync } from "glob";
import { compareBytewise } from "../../services/ref-resolver/index.js";
import { realPathInside } from "../include-resolver.js";
import { inferGlobBase } from "../markdown-compiler.js";
import { compileRecipeKeyMatcher } from "./recipe-key-matcher.js";
import {
  listLockedRecipes,
  readRecipeManifestIn,
  type LockedRecipeLocation,
} from "./locked-recipes.js";

/** One memory file an active recipe publishes. */
export type MemoryFile = {
  /** The recipe key, `namespace/recipe`. */
  recipe: string;
  /** The path inside the `#memories` view, without the `#memories/` prefix. */
  path: string;
  /** The real file's absolute path. */
  file: string;
  /** The file's path relative to its recipe's directory, for messages. */
  relative: string;
};

/** What listing the memories needs. */
export type MemoryListingOptions = {
  /** The project's `.sous/` directory. */
  sousDir: string;
  /** The environment to read; decides where the store is. */
  env?: NodeJS.ProcessEnv;
  /** `recipes.memories.first`: recipes whose memories lead. */
  first?: readonly string[] | undefined;
  /** `recipes.memories.exclude`: recipes whose memories are left out. */
  exclude?: readonly string[] | undefined;
  /** The locked recipes, when the caller has already located them. */
  locked?: LockedRecipeLocation[];
  /**
   * Receives a sentence for each memory skipped because its real path is
   * outside its recipe's directory. Defaults to one line on stderr per file.
   */
  onWarning?: (message: string) => void;
};

/** Files already warned about by the default sink, so a repeated listing warns once. */
const warnedFiles = new Set<string>();

/** The default warning sink: one line on stderr, once per file. */
function warnOnce(message: string): void {
  if (warnedFiles.has(message)) return;
  warnedFiles.add(message);
  process.stderr.write(`Warning: ${message}\n`);
}

/**
 * Orders recipe keys so each comes after every pinned recipe it depends on or
 * subscribes to, ties by key. A lockfile entry's `requestedBy` names the recipes
 * that asked for it, which is the dependency edge read backwards. A cycle (which
 * a resolved lockfile should not hold) leaves its members in key order at the end.
 *
 * @param locked - Every pinned recipe.
 */
export function dependencyOrder(locked: readonly LockedRecipeLocation[]): string[] {
  // A recipe waits for every pinned recipe that lists it among its holders.
  const waitingOn = new Map<string, Set<string>>();
  for (const recipe of locked) waitingOn.set(recipe.key, new Set());
  for (const dependency of locked) {
    for (const holder of dependency.requestedBy) {
      if (holder !== dependency.key) waitingOn.get(holder)?.add(dependency.key);
    }
  }

  const ordered: string[] = [];
  const done = new Set<string>();
  const remaining = [...waitingOn.keys()].sort(compareBytewise);
  while (remaining.length > 0) {
    const index = remaining.findIndex((key) => [...waitingOn.get(key)!].every((dep) => done.has(dep)));
    if (index === -1) {
      ordered.push(...remaining);
      break;
    }
    const [key] = remaining.splice(index, 1);
    ordered.push(key!);
    done.add(key!);
  }
  return ordered;
}

/**
 * Lists the memories of every active recipe, in view order, with the recipes
 * that `exclude` names left out.
 *
 * @param options - The project, and the `first` and `exclude` lists.
 */
export function listMemories(options: MemoryListingOptions): MemoryFile[] {
  const locked =
    options.locked ??
    listLockedRecipes({
      sousDir: options.sousDir,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  if (locked.length === 0) return [];

  const isFirst = compileRecipeKeyMatcher(options.first, "recipes.memories.first");
  const isExcluded = compileRecipeKeyMatcher(options.exclude, "recipes.memories.exclude");
  const byKey = new Map(locked.map((recipe) => [recipe.key, recipe]));

  const order = dependencyOrder(locked);
  const leading = order.filter((key) => isFirst(key));
  const rest = order.filter((key) => !isFirst(key));

  const files: MemoryFile[] = [];
  for (const key of [...leading, ...rest]) {
    const recipe = byKey.get(key)!;
    if (recipe.kind !== "subscribes" || !recipe.present || isExcluded(key)) continue;
    const manifest = readRecipeManifestIn(recipe.dir);
    if (manifest === undefined) continue;

    const mine = new Map<string, MemoryFile>();
    for (const content of manifest.contents) {
      if (content.kind !== "memories") continue;
      const ignore = (content.exclude ?? []).map((pattern) => path.join(recipe.dir, pattern));
      for (const include of content.include) {
        const pattern = path.join(recipe.dir, include);
        const base = inferGlobBase(pattern);
        for (const file of globSync(pattern, { absolute: true, ignore, dot: true })) {
          if (!isFile(file)) continue;
          if (!realPathInside(file, recipe.dir)) {
            (options.onWarning ?? warnOnce)(
              `The memory ${file} of the recipe ${key} was left out, because it is a link ` +
                `that leads outside the recipe's directory. Replace the link with the file itself.`
            );
            continue;
          }
          const inside = path.relative(base, file).split(path.sep).join("/");
          mine.set(file, {
            recipe: key,
            path: `${key}/${inside}`,
            file,
            relative: path.relative(recipe.dir, file).split(path.sep).join("/"),
          });
        }
      }
    }
    files.push(...[...mine.values()].sort((a, b) => compareBytewise(a.path, b.path)));
  }
  return files;
}

/** True when the path is a regular file. */
function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
