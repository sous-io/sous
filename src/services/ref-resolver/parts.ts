/**
 * Reading the parents out of a nested ref, wherever a kind keeps them.
 */

import type {
  NamespaceRef,
  RecipeRef,
  RefLocation,
  RepoRef,
  SousRef,
} from "./types.js";

/**
 * The repository qualifier a ref was written with, wherever it sits in the
 * nesting. A repository ref is its own qualifier.
 *
 * repoOf(parse("sous-recipes:workflow/alpha")); // -> { kind: "repo", name: "sous-recipes" }
 *
 * @param ref - Any ref.
 */
export function repoOf(ref: SousRef): RepoRef | undefined {
  switch (ref.kind) {
    case "repo":
      return ref;
    case "namespace":
      return ref.repo;
    case "recipe":
      return ref.namespace?.repo ?? ref.repo;
    case "recipeFile":
      return repoOf(ref.recipe);
    case "variable":
      return ref.recipe === undefined ? ref.repo : (repoOf(ref.recipe) ?? ref.repo);
    case "envVar":
      return undefined;
  }
}

/**
 * Where the ref says its repository lives, when it says.
 *
 * @param ref - Any ref.
 */
export function locationOf(ref: SousRef): RefLocation | undefined {
  return repoOf(ref)?.location;
}

/**
 * The namespace a ref names or sits in.
 *
 * @param ref - Any ref.
 */
export function namespaceOf(ref: SousRef): NamespaceRef | undefined {
  switch (ref.kind) {
    case "namespace":
      return ref;
    case "recipe":
      return ref.namespace;
    case "recipeFile":
      return ref.recipe.namespace;
    case "variable":
      return ref.recipe?.namespace;
    default:
      return undefined;
  }
}

/**
 * The recipe a ref names or sits in.
 *
 * @param ref - Any ref.
 */
export function recipeOf(ref: SousRef): RecipeRef | undefined {
  switch (ref.kind) {
    case "recipe":
      return ref;
    case "recipeFile":
      return ref.recipe;
    case "variable":
      return ref.recipe;
    default:
      return undefined;
  }
}

/**
 * The version range a ref carries, when it carries one.
 *
 * @param ref - Any ref.
 */
export function rangeOf(ref: SousRef): string | undefined {
  return ref.kind === "recipe" || ref.kind === "recipeFile" || ref.kind === "repo"
    ? ref.range
    : undefined;
}

/**
 * Every name and path part of a ref and its parents, outermost parent first.
 *
 * namesOf(parse("sous-recipes:workflow/alpha")); // -> ["sous-recipes", "workflow", "alpha"]
 *
 * @param ref - Any ref.
 */
export function namesOf(ref: SousRef): string[] {
  const names: string[] = [];
  const repo = repoOf(ref);
  if (repo?.name !== undefined) names.push(repo.name);
  if (ref.kind === "repo") return names;
  const namespace = namespaceOf(ref);
  if (namespace !== undefined) names.push(namespace.name);
  const recipe = recipeOf(ref);
  if (recipe !== undefined) names.push(recipe.name);
  if (ref.kind === "recipeFile") names.push(ref.path);
  if (ref.kind === "variable" || ref.kind === "envVar") names.push(ref.name);
  return names;
}
