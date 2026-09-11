/**
 * Working out what a one-word ref means.
 *
 * A ref with two segments says exactly what it names: `workflow/task-files` is
 * the recipe `task-files` in the namespace `workflow`. A ref with one segment
 * is a guess at a name, and the name may be either kind of thing:
 *
 *     sous subscribe workflow        the whole namespace 'workflow'
 *     sous subscribe task-files      the recipe named 'task-files', wherever it lives
 *
 * Both meanings are searched, in that order, across the cached index of every
 * repository the project trusts:
 *
 *   1. an exact namespace match, in any trusted repository;
 *   2. an exact recipe-name match, in any namespace of any trusted repository.
 *
 * A word can be both (a namespace called `task-files` in one repository and a
 * recipe called `task-files` in another), which is why the two searches are
 * added together rather than the first one winning outright. The caller decides
 * what to do with the result: nothing found is an error naming what was
 * searched, one candidate proceeds, and several ask.
 *
 * The order candidates come back in is part of the contract, because it is the
 * order they are listed in and the one `--accept-first` picks from. It is:
 * repository first, in the order the repositories were given (the caller puts
 * the built-in repository first, then the ones the config names, in config
 * order); then namespace alphabetically; then, within a namespace, the
 * whole-namespace candidate before its recipes, and recipes alphabetically.
 */

import type { IndexFile } from "./formats/index-file.js";
import type { ParsedRef } from "./ref.js";

/** One thing a one-word ref could have meant. */
export type RefCandidate = {
  /** The repository holding it. */
  repo: string;
  /** The namespace it names, or the namespace the recipe lives in. */
  namespace: string;
  /** The recipe name, absent when the candidate is a whole namespace. */
  recipe?: string;
  /** The fully qualified ref, `repo:namespace` or `repo:namespace/recipe`. */
  ref: string;
  /** Which of the two searches turned it up. */
  kind: "namespace" | "recipe";
  /** The recipe's one-paragraph summary, when its index carries one. */
  description?: string;
};

/** What the search reads. */
export type RefSearchInputs = {
  /** The one-word name being resolved. */
  name: string;
  /**
   * The repositories to search, in the order their candidates should be listed:
   * the built-in repository first, then the ones the config names, in config
   * order.
   */
  repoOrder: string[];
  /** The cached index of each repository, keyed by short name. */
  indexes: Map<string, IndexFile>;
};

/**
 * Every meaning a one-word ref could have, in the documented order.
 *
 * @param inputs - The name, the repositories to search and their indexes.
 */
export function searchBareName(inputs: RefSearchInputs): RefCandidate[] {
  const namespaceHits: RefCandidate[] = [];
  const recipeHits: RefCandidate[] = [];

  for (const repo of inputs.repoOrder) {
    const index = inputs.indexes.get(repo);
    if (index === undefined) continue;

    if (Object.hasOwn(index.namespaces, inputs.name)) {
      namespaceHits.push({
        repo,
        namespace: inputs.name,
        ref: `${repo}:${inputs.name}`,
        kind: "namespace",
      });
    }

    for (const [key, recipe] of Object.entries(index.recipes)) {
      const slash = key.indexOf("/");
      if (slash === -1) continue;
      const namespace = key.slice(0, slash);
      const name = key.slice(slash + 1);
      if (name !== inputs.name) continue;

      recipeHits.push({
        repo,
        namespace,
        recipe: name,
        ref: `${repo}:${key}`,
        kind: "recipe",
        ...(recipe.description === undefined ? {} : { description: recipe.description }),
      });
    }
  }

  const order = new Map(inputs.repoOrder.map((repo, position) => [repo, position]));
  const byOrder = (left: RefCandidate, right: RefCandidate): number => {
    const repos = (order.get(left.repo) ?? 0) - (order.get(right.repo) ?? 0);
    if (repos !== 0) return repos;
    if (left.namespace !== right.namespace) {
      return left.namespace < right.namespace ? -1 : 1;
    }
    // A whole namespace is listed before the recipes inside it.
    const leftRecipe = left.recipe ?? "";
    const rightRecipe = right.recipe ?? "";
    if (leftRecipe === rightRecipe) return 0;
    return leftRecipe < rightRecipe ? -1 : 1;
  };

  return [...namespaceHits.sort(byOrder), ...recipeHits.sort(byOrder)];
}

/**
 * Describes one candidate in the words a person choosing between them needs:
 * the fully qualified ref, and what it actually means.
 *
 * @param candidate - The candidate to describe.
 */
export function describeCandidate(candidate: RefCandidate): string {
  if (candidate.kind === "namespace") {
    return (
      `${candidate.ref}  (the whole namespace '${candidate.namespace}' in the ` +
      `repository '${candidate.repo}')`
    );
  }
  const summary = candidate.description === undefined ? "" : `: ${candidate.description}`;
  return (
    `${candidate.ref}  (the recipe '${candidate.recipe}' in the namespace ` +
    `'${candidate.namespace}' of the repository '${candidate.repo}'${summary})`
  );
}

/**
 * Turns a chosen candidate back into a parsed ref, carrying over the version
 * range the original ref asked for. The repository qualifier is kept, so what
 * gets resolved is exactly the candidate that was chosen and not another
 * repository's recipe of the same name.
 *
 * @param candidate - The candidate that was chosen.
 * @param original - The ref as the user wrote it.
 */
export function candidateToRef(candidate: RefCandidate, original: ParsedRef): ParsedRef {
  return {
    repo: candidate.repo,
    namespace: candidate.namespace,
    ...(candidate.recipe === undefined ? {} : { recipe: candidate.recipe }),
    ...(original.range === undefined ? {} : { range: original.range }),
  };
}

/**
 * The error a name that matched nothing raises: what was looked for, and every
 * repository whose index was searched, so the reader can tell "the name is
 * wrong" from "the repository holding it was never added".
 *
 * @param inputs - The same inputs the search was given.
 */
export function describeSearch(inputs: RefSearchInputs): string[] {
  const searched = inputs.repoOrder.filter((repo) => inputs.indexes.has(repo));
  const missing = inputs.repoOrder.filter((repo) => !inputs.indexes.has(repo));

  const lines = [
    searched.length === 0
      ? `  No repository index could be read, so there was nothing to search.`
      : `  Searched the namespaces and the recipe names of: ${searched.join(", ")}.`,
  ];
  if (missing.length > 0) {
    lines.push(
      `  These repositories are trusted but their index could not be read, so nothing ` +
        `in them was searched: ${missing.join(", ")}.`
    );
  }
  return lines;
}
