/**
 * The real namespace resolver: the one the compiler uses.
 *
 * Phase 4 defined the `NamespaceResolver` contract and shipped an in-memory
 * implementation for tests. This is the implementation backed by the project's
 * actual state: the lockfile says which recipes are in play and at what version,
 * the links map and the store say where each one's files are, and each recipe's
 * own manifest says what it is allowed to address.
 *
 * The scoping rule is the whole point, and it is enforced by handing
 * `StaticNamespaceResolver` the right two maps:
 *
 *   - a file inside a recipe may address only that recipe's own declared
 *     dependencies (`depends` plus `subscribes`), at their pinned versions;
 *   - a file in the project's own templates may address every recipe the
 *     lockfile pins, whatever holds it: the project, a set it subscribes to,
 *     or another recipe's `depends`.
 *
 * When a project template names a recipe the lockfile does not pin, the error
 * says which recipe used to bring it in, when the cached indexes or the config
 * can tell.
 *
 * A project with no lockfile entries gets no resolver at all, so a project that
 * uses no repositories behaves exactly as it did before: `~` in an include line
 * means an alias and nothing else.
 */

import semver from "semver";
import type { Settings } from "../settings.js";
import { resolveStoreRoot } from "../sous-home.js";
import {
  StaticNamespaceResolver,
  normalizeRef,
  type DroppedRecipe,
  type NamespaceResolver,
} from "./namespace-resolver.js";
import {
  listLockedRecipes,
  readProjectLockfile,
  readRecipeManifestIn,
  type LockedRecipeLocation,
} from "./locked-recipes.js";
import { createIndexCache } from "./providers/index.js";
import type { IndexFile } from "./formats/index-file.js";
import type { Lockfile } from "./formats/lockfile.js";

/** How the project's namespace resolver is built. */
export type ProjectNamespaceResolverOptions = {
  /** The project's `.sous/` directory, which holds the lockfile and the links map. */
  sousDir: string;
  /** The merged project config, read for its subscriptions. */
  settings: Settings;
  /** The environment to read; decides where the store and machine-wide links map are. */
  env?: NodeJS.ProcessEnv;
  /** The locked recipes, when the caller has already located them. */
  locked?: LockedRecipeLocation[];
};

/**
 * Builds the namespace resolver for a project, or undefined when the project
 * locks no recipes at all.
 *
 * createProjectNamespaceResolver({ sousDir, settings })
 * // -> resolves "@~workflow/task-files/_partials/resume.md" to the pinned
 * //    recipe directory, when the project (or the including recipe) may address it
 *
 * @param options - The project's `.sous/` directory, its config and the environment.
 */
export function createProjectNamespaceResolver(
  options: ProjectNamespaceResolverOptions
): NamespaceResolver | undefined {
  const locked =
    options.locked ??
    listLockedRecipes({
      sousDir: options.sousDir,
      ...(options.env === undefined ? {} : { env: options.env }),
    });

  if (locked.length === 0) return undefined;

  const recipes: Record<string, string> = {};
  const dependencies: Record<string, string[]> = {};

  for (const recipe of locked) {
    recipes[recipe.key] = recipe.dir;

    // A recipe declares what it may address in its own manifest. A recipe whose
    // files are not on disk yet declares nothing, which is the conservative
    // answer: it cannot be including anything either.
    const manifest = recipe.present ? readRecipeManifestIn(recipe.dir) : undefined;
    if (manifest === undefined) continue;

    const declared = [...(manifest.depends ?? []), ...(manifest.subscribes ?? [])];
    if (declared.length > 0) dependencies[recipe.key] = declared;
  }

  // No `projectScope`: a project template may address every recipe the
  // lockfile pins, and those are exactly the recipes this resolver knows.
  return new StaticNamespaceResolver({
    recipes,
    dependencies,
    explainMissing: (recipe) => explainUnpinnedRecipe(recipe, options),
  });
}

/**
 * Why the lockfile does not pin a recipe a project template asked for, when
 * that can be known without the network. Two things are checked, in order:
 *
 *   - a subscription to it (or to its namespace) that is switched off;
 *   - another published version of a pinned recipe that brought it in, read
 *     from the cached indexes of the lockfile's repositories. That version may
 *     declare it directly, or declare a recipe that no longer is pinned either
 *     and that declares it in turn; the shortest such chain is reported, and
 *     among the versions of one pinned recipe the newest wins. This is the
 *     usual story of a set that dropped one of its members, and the members'
 *     own libraries with it.
 *
 * Only ever runs while an error is being reported, so it reads the lockfile
 * and the cached indexes then rather than on every build.
 *
 * @param recipe - The `namespace/recipe` the template asked for.
 * @param options - The project's `.sous/` directory, its config and the environment.
 */
export function explainUnpinnedRecipe(
  recipe: string,
  options: Pick<ProjectNamespaceResolverOptions, "sousDir" | "settings" | "env">
): DroppedRecipe | undefined {
  const namespace = recipe.slice(0, recipe.indexOf("/"));
  for (const [key, entry] of Object.entries(options.settings.subscriptions ?? {})) {
    if (entry?.enabled !== false) continue;
    const ref = normalizeRef(key);
    if (ref === recipe || ref === namespace) {
      return { by: "disabled-subscription", subscription: key };
    }
  }

  let lock: Lockfile;
  try {
    lock = readProjectLockfile(options.sousDir);
  } catch {
    // The build reports a broken lockfile on its own; an error message is no
    // place to report it a second time.
    return undefined;
  }

  const published = publishedVersions(lock, options.env ?? process.env);

  /** What one published version of a recipe declares, as recipe keys. */
  const declaredBy = (key: string, version: string): string[] =>
    Object.keys(published.get(key)?.[version]?.dependencies ?? {});

  // Breadth first from every other version of every pinned recipe, through
  // recipes the lockfile does not pin, so the shortest chain is found first.
  type Step = { key: string; root: { recipe: string; version: string }; through: string[] };
  const queue: Step[] = [];
  for (const holder of Object.keys(lock.recipes).sort()) {
    const pinned = lock.recipes[holder]!.version;
    const versions = Object.keys(published.get(holder) ?? {})
      .filter((version) => version !== pinned && semver.valid(version) !== null)
      .sort(semver.rcompare);
    for (const version of versions) {
      for (const key of declaredBy(holder, version)) {
        queue.push({ key, root: { recipe: holder, version }, through: [] });
      }
    }
  }

  const seen = new Set<string>();
  while (queue.length > 0) {
    const step = queue.shift()!;
    if (step.key === recipe) {
      const root = step.root;
      return {
        by: "recipe",
        recipe: root.recipe,
        declaredAt: root.version,
        pinned: lock.recipes[root.recipe]!.version,
        ...(step.through.length > 0 ? { through: step.through } : {}),
      };
    }
    // A pinned recipe is explained by its own entry, and each recipe is
    // walked once.
    if (Object.hasOwn(lock.recipes, step.key) || seen.has(step.key)) continue;
    seen.add(step.key);
    for (const version of Object.keys(published.get(step.key) ?? {})) {
      for (const key of declaredBy(step.key, version)) {
        queue.push({ key, root: step.root, through: [...step.through, step.key] });
      }
    }
  }

  return undefined;
}

/**
 * Every published version of every recipe in the cached indexes of the
 * repositories the lockfile names, keyed by recipe. A repository with no
 * cached index contributes nothing.
 *
 * @param lock - The project's lockfile.
 * @param env - The environment, which decides where the store is.
 */
function publishedVersions(
  lock: Lockfile,
  env: NodeJS.ProcessEnv
): Map<string, IndexFile["recipes"][string]["versions"]> {
  const cache = createIndexCache({ storeRoot: resolveStoreRoot(env) });
  const found = new Map<string, IndexFile["recipes"][string]["versions"]>();
  const identities = new Set(Object.values(lock.repos).map((repo) => repo.identity));
  for (const identity of [...identities].sort()) {
    const index = cache.readCached(identity);
    for (const [key, entry] of Object.entries(index?.recipes ?? {})) {
      if (!found.has(key)) found.set(key, entry.versions);
    }
  }
  return found;
}
