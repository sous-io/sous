/**
 * Reading the parents out of a nested ref, wherever a kind keeps them, and the order refs are
 * listed in.
 */

import type { NamespaceRef, RecipeRef, RefKind, RefLocation, RepoRef, SousRef } from "./types.js";

/** Every kind, in the order matches of equal specificity are listed in. */
export const REF_KINDS: readonly RefKind[] = ["repo", "namespace", "recipe", "recipeFile", "variable", "envVar"];

/** What each kind is called in a sentence. */
export const KIND_LABELS: Readonly<Record<RefKind, string>> = {
    repo: "repository",
    namespace: "namespace",
    recipe: "recipe",
    recipeFile: "recipe file",
    variable: "variable",
    envVar: "environment variable",
};

/**
 * The repository qualifier a ref was written with, wherever it sits in the nesting. A repository
 * ref is its own qualifier.
 *
 * ```ts
 * repoOf(recipe "alpha" in "sous-recipes:workflow"); // -> { kind: "repo", name: "sous-recipes" }
 * ```
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

/** Where the ref says its repository lives, when it says. */
export function locationOf(ref: SousRef): RefLocation | undefined {
    return repoOf(ref)?.location;
}

/** The namespace a ref names or sits in. */
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

/** The recipe a ref names or sits in. */
export function recipeOf(ref: SousRef): RecipeRef | undefined {
    switch (ref.kind) {
        case "recipe":
            return ref;
        case "recipeFile":
        case "variable":
            return ref.recipe;
        default:
            return undefined;
    }
}

/** The version range a ref carries, when it carries one. */
export function rangeOf(ref: SousRef): string | undefined {
    return ref.kind === "recipe" || ref.kind === "recipeFile" || ref.kind === "repo" ? ref.range : undefined;
}

/**
 * Every name and path part of a ref and its parents, outermost parent first.
 *
 * ```ts
 * namesOf(recipe "alpha" in "sous-recipes:workflow"); // -> ["sous-recipes", "workflow", "alpha"]
 * ```
 */
export function namesOf(ref: SousRef): string[] {
    const names: string[] = [];
    const repo = repoOf(ref);

    if (repo?.name !== undefined) {
        names.push(repo.name);
    }

    if (ref.kind === "repo") {
        return names;
    }

    const namespace = namespaceOf(ref);
    const recipe = recipeOf(ref);

    if (namespace !== undefined) {
        names.push(namespace.name);
    }

    if (recipe !== undefined) {
        names.push(recipe.name);
    }

    if (ref.kind === "recipeFile") {
        names.push(ref.path);
    }

    if (ref.kind === "variable" || ref.kind === "envVar") {
        names.push(ref.name);
    }

    return names;
}

/**
 * How qualified the spelling that produced a reading was. Lower is more specific, and the listing
 * order follows it: a fully qualified ref first, then a partly qualified one, then a bare name, and
 * an environment variable name last (the least likely reading of a plain word).
 */
export function qualificationOf(candidate: SousRef): number {
    if (candidate.kind === "envVar") {
        return 3;
    }

    if (candidate.kind === "repo" || repoOf(candidate) !== undefined) {
        return 0;
    }

    const partial =
        (candidate.kind === "recipe" && candidate.namespace !== undefined) ||
        candidate.kind === "recipeFile" ||
        (candidate.kind === "variable" && candidate.recipe !== undefined);

    return partial ? 1 : 2;
}

/** True when a ref is a namespace, or a recipe that names its namespace. */
export function isStoredKind(ref: SousRef): ref is NamespaceRef | RecipeRef {
    return ref.kind === "namespace" || (ref.kind === "recipe" && ref.namespace !== undefined);
}

/**
 * The short key of a namespace or a recipe, `namespace` or `namespace/recipe`, as the lockfile and
 * the index store it, in the case it was written.
 */
export function shortKey(ref: SousRef): string {
    const namespace = namespaceOf(ref)?.name;
    const recipe = ref.kind === "namespace" ? undefined : recipeOf(ref)?.name;

    if (namespace === undefined) {
        return recipe ?? "";
    }

    return recipe === undefined ? namespace : `${namespace}/${recipe}`;
}
