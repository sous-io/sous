/**
 * Names and fixed values part B of plugin-recipes shares between its modules.
 */

/** The plugin's name, as registrations and contexts carry it. */
export const RECIPES_PLUGIN = "@sous-io/plugin-recipes";

/** The lockfile, inside `.sous/`. */
export const LOCKFILE_NAME = "sous.lock.json";

/** The links map, inside `.sous/` or sous home. */
export const LINKS_FILE_NAME = "sous.links.json";

/** The directory, inside `.sous/`, that linked checkouts are cloned into. */
export const PROJECT_REPOS_DIRNAME = "repos";

/** The directory, inside `.sous/`, that recipe plugins' `.d.ts` files are copied into (S1). */
export const TYPES_DIRNAME = "types";

/** The holder a subscription of the project itself is recorded under in `requestedBy`. */
export const PROJECT_HOLDER = "project";

/** The `addedBy` of an entry sous provides itself. */
export const BUILT_IN_ADDED_BY = "sous";

/** The short name the official repository is recorded under in every project. */
export const OFFICIAL_REPO_NAME = "sous-recipes";

/** Where the official repository lives. */
export const OFFICIAL_REPO_URL = "https://github.com/sous-io/sous-recipes";

/** The official repository's identity, which the store and the index cache file it under. */
export const OFFICIAL_REPO_IDENTITY = "github.com/sous-io/sous-recipes";

/** The `repository-host` that reads the official repository. */
export const OFFICIAL_REPO_PROVIDER = "github";

/** The namespace every project is subscribed to unless it opts out. */
export const CORE_NAMESPACE = "core";

/** The recipe published in it. */
export const CORE_RECIPE_NAME = "sous-skills";

/** `core/sous-skills`. */
export const CORE_RECIPE_KEY = `${CORE_NAMESPACE}/${CORE_RECIPE_NAME}`;

/** The directory inside the package holding every recipe sous ships. */
export const PACKAGED_RECIPES_DIRNAME = "recipes";

/** The core recipe's folder, relative to the repository root, as the index records it. */
export const CORE_RECIPE_PATH = `${PACKAGED_RECIPES_DIRNAME}/${CORE_NAMESPACE}/${CORE_RECIPE_NAME}`;

/** The default freshness window of a fetched index, in seconds. */
export const DEFAULT_FRESHNESS_SECONDS = 300;

/** The ids of part B's contributors. */
export const CONTRIBUTORS = {
    core: "recipes.core",
    fetch: "recipes.fetch",
    configLayers: "recipes.config-layers",
    plugins: "recipes.plugins",
} as const;
