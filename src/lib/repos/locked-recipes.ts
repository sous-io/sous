/**
 * Where a locked recipe's files actually are.
 *
 * The lockfile pins a recipe to a repository, a version and a content hash; it
 * does not say where the bytes live. Three consumers need that answer and must
 * all get the same one: the namespace resolver (which recipe directory a
 * `~namespace` include lands in), the variable definition source (which
 * manifests `sous vars` reads), and the recipe compile targets (which files a
 * build copies or renders).
 *
 * There are two possible homes, and the order matters. A LINKED repository is
 * read from its working copy, because a link is a deliberate instruction to
 * bypass versions and the lockfile; everything else is read from the immutable
 * store entry at the locked version. Nothing here fetches anything: a recipe the
 * store does not hold yet is reported as absent so the caller can restore it.
 *
 * Reading is done once per call and cached inside the returned list, because a
 * build asks for the same answer several times in a row.
 */

import fs from "node:fs";
import path from "node:path";
import type { Settings } from "../settings.js";
import { resolveStoreRoot } from "../sous-home.js";
import { parseLockfile, type LockKind, type Lockfile } from "./formats/lockfile.js";
import { parseRecipeManifest, type RecipeManifest } from "./formats/recipe-manifest.js";
import { parseRepoManifest, type RepoManifest } from "./formats/repo-manifest.js";
import { LOCKFILE_FILENAME } from "./formats/common.js";
import {
  findRecipeManifest,
  findRepoManifest,
  loadJsonFile,
  loadManifestFile,
} from "./load-manifest.js";
import { readEffectiveLinks } from "./links.js";
import { enabledSubscriptions } from "./defaults.js";
import { PROJECT_HOLDER } from "./formats/lockfile.js";

/** One locked recipe, together with the directory its files are read from. */
export type LockedRecipeLocation = {
  /** The recipe key, `namespace/recipe`. */
  key: string;
  /** The short name of the repository it came from. */
  repo: string;
  /** The recipe's namespace. */
  namespace: string;
  /** The recipe's name. */
  name: string;
  /** The exact version the lockfile pins. */
  version: string;
  /** The content hash the lockfile pins. */
  hash: string;
  /** Whether anything holds it as a co-subscription, or only as a build dependency. */
  kind: LockKind;
  /** Everyone holding it: "project", and the key of every recipe that asked. */
  requestedBy: string[];
  /** Absolute directory holding the recipe's files. */
  dir: string;
  /** True when `dir` is a linked working copy rather than a store entry. */
  linked: boolean;
  /** True when `dir` exists on disk right now. */
  present: boolean;
};

/** How locked recipes are located. */
export type LockedRecipeOptions = {
  /** The project's `.sous/` directory, which holds the lockfile and the links map. */
  sousDir: string;
  /** The environment to read; decides where the store and the machine-wide links map are. */
  env?: NodeJS.ProcessEnv;
  /** The store root to use instead of the one the environment implies. */
  storeRoot?: string;
};

/**
 * Reads and validates a project's lockfile, returning an empty one when the
 * project has locked nothing yet.
 *
 * @param sousDir - The project's `.sous/` directory.
 */
export function readProjectLockfile(sousDir: string): Lockfile {
  const filePath = path.join(sousDir, LOCKFILE_FILENAME);
  if (!fs.existsSync(filePath)) return { formatVersion: 1, repos: {}, recipes: {} };
  return parseLockfile(loadJsonFile(filePath, "lockfile"), filePath);
}

/**
 * Reads and validates the recipe manifest in a directory, returning undefined
 * when the directory has none or does not exist. A recipe that is not on disk
 * yet is an ordinary state (a fresh clone before restore), never an error here.
 *
 * @param recipeDir - The directory holding the recipe's files.
 */
export function readRecipeManifestIn(recipeDir: string): RecipeManifest | undefined {
  let manifestPath: string | undefined;
  try {
    manifestPath = findRecipeManifest(recipeDir);
  } catch {
    return undefined;
  }
  if (manifestPath === undefined) return undefined;
  return parseRecipeManifest(loadManifestFile(manifestPath), manifestPath);
}

/**
 * Reads and validates the repo manifest at the root of a checkout, returning
 * undefined when there is none.
 *
 * @param repoRoot - The checkout's root directory.
 */
export function readRepoManifestIn(repoRoot: string): RepoManifest | undefined {
  let manifestPath: string | undefined;
  try {
    manifestPath = findRepoManifest(repoRoot);
  } catch {
    return undefined;
  }
  if (manifestPath === undefined) return undefined;
  return parseRepoManifest(loadManifestFile(manifestPath), manifestPath);
}

/**
 * Maps every recipe a linked checkout publishes to its directory, by reading the
 * checkout's repo manifest and then each recipe folder's own manifest. A folder
 * the repo manifest lists but that holds no readable recipe manifest is skipped
 * rather than failing the build: a working copy is edited by hand and is allowed
 * to be mid-change.
 *
 * @param checkoutDir - The linked working copy's root directory.
 */
export function mapLinkedRecipes(checkoutDir: string): Record<string, string> {
  const manifest = readRepoManifestIn(checkoutDir);
  if (manifest === undefined) return {};

  const found: Record<string, string> = {};
  for (const relative of manifest.recipes) {
    const recipeDir = path.join(checkoutDir, relative);
    const recipe = readRecipeManifestIn(recipeDir);
    if (recipe === undefined) continue;
    found[`${recipe.namespace}/${recipe.name}`] = recipeDir;
  }
  return found;
}

/**
 * Every recipe the lockfile pins, with the directory each one's files are read
 * from. Linked repositories win over the store, and a recipe whose directory is
 * not there yet comes back with `present: false`.
 *
 * @param options - The project's `.sous/` directory and the environment.
 */
export function listLockedRecipes(
  options: LockedRecipeOptions
): LockedRecipeLocation[] {
  const env = options.env ?? process.env;
  const lock = readProjectLockfile(options.sousDir);
  const keys = Object.keys(lock.recipes);
  if (keys.length === 0) return [];

  const storeRoot = options.storeRoot ?? resolveStoreRoot(env);
  const links = readEffectiveLinks(options.sousDir, env);
  const linkedRecipes = new Map<string, Record<string, string>>();

  const located: LockedRecipeLocation[] = [];

  for (const key of keys.sort()) {
    const entry = lock.recipes[key]!;
    const namespace = key.slice(0, key.indexOf("/"));
    const name = key.slice(namespace.length + 1);

    let dir: string | undefined;
    let linked = false;

    const checkout = links[entry.repo]?.path;
    if (checkout !== undefined) {
      if (!linkedRecipes.has(entry.repo)) {
        linkedRecipes.set(entry.repo, mapLinkedRecipes(checkout));
      }
      dir = linkedRecipes.get(entry.repo)![key];
      linked = dir !== undefined;
    }

    if (dir === undefined) {
      dir = path.join(storeRoot, entry.repo, namespace, name, entry.version);
    }

    located.push({
      key,
      repo: entry.repo,
      namespace,
      name,
      version: entry.version,
      hash: entry.hash,
      kind: entry.kind,
      requestedBy: [...entry.requestedBy],
      dir,
      linked,
      present: fs.existsSync(dir),
    });
  }

  return located;
}

/**
 * The refs a project's own templates may address: everything it subscribed to
 * directly. Both sources are read, because a subscription may be written by
 * `sous subscribe` into the managed layer, hand-written in the primary config,
 * or (for an older project) recorded only in the lockfile.
 *
 * @param settings - The merged project config.
 * @param locked - The locked recipes, as returned by listLockedRecipes.
 */
export function projectSubscriptionRefs(
  settings: Settings,
  locked: LockedRecipeLocation[]
): string[] {
  const refs = new Set<string>(Object.keys(enabledSubscriptions(settings)));
  for (const recipe of locked) {
    if (recipe.requestedBy.includes(PROJECT_HOLDER)) refs.add(recipe.key);
  }
  return [...refs].sort();
}
