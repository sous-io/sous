/**
 * Predicates and wording the per-place pruners share.
 */

import { locationOf, namespaceOf, recipeOf, repoOf } from "../parts.js";
import type { SousRef } from "../types.js";

/** True when the ref names a repository that lives on this machine. */
export function isLocal(ref: SousRef): boolean {
  return locationOf(ref)?.provider === "local";
}

/** True when the ref names where its repository lives. */
export function hasLocation(ref: SousRef): boolean {
  return locationOf(ref) !== undefined;
}

/** True when the ref is qualified by a repository short name (`repo:`). */
export function hasRepoName(ref: SousRef): boolean {
  return ref.kind !== "repo" && repoOf(ref)?.name !== undefined;
}

/** True when the ref is a namespace, or a recipe that names its namespace. */
export function isStoredKind(ref: SousRef): boolean {
  return ref.kind === "namespace" || (ref.kind === "recipe" && ref.namespace !== undefined);
}

/**
 * The short key of a namespace or a recipe: `namespace` or `namespace/recipe`,
 * as the lockfile and the index store it, in the case it was written.
 *
 * @param ref - A namespace or a recipe.
 */
export function shortKey(ref: SousRef): string {
  const namespace = namespaceOf(ref)?.name;
  const recipe = ref.kind === "namespace" ? undefined : recipeOf(ref)?.name;
  if (namespace === undefined) return recipe ?? "";
  return recipe === undefined ? namespace : `${namespace}/${recipe}`;
}

/** The sentence for a reading that is not a name a place can hold. */
export const KEBAB_REASON =
  "only a namespace or a recipe can be named here, and their names must be kebab-case: " +
  "a letter, then letters, digits or hyphens.";
