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
 *   - a file in the project's own templates may address the project's
 *     subscriptions.
 *
 * A project with no lockfile entries gets no resolver at all, so a project that
 * uses no repositories behaves exactly as it did before: `~` in an include line
 * means an alias and nothing else.
 */

import type { Settings } from "../settings.js";
import {
  StaticNamespaceResolver,
  type NamespaceResolver,
} from "./namespace-resolver.js";
import {
  listLockedRecipes,
  projectSubscriptionRefs,
  readRecipeManifestIn,
  type LockedRecipeLocation,
} from "./locked-recipes.js";

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

  return new StaticNamespaceResolver({
    recipes,
    dependencies,
    projectScope: projectSubscriptionRefs(options.settings, locked),
  });
}
