/**
 * Printing a ref: its key (what everything is stored and compared under) and
 * its canonical written form (how sous prints it).
 */

import {
  builtInProviders,
  providerById,
  type RepoProvider,
} from "../../lib/repos/providers/index.js";
import { repoOf } from "./parts.js";
import { KIND_LABELS, type RepoRef, type SousRef } from "./types.js";

/**
 * The part of a key that names the repository: its short name, or its
 * identity when it was named by location.
 */
function repoPart(repo: RepoRef | undefined): string | undefined {
  if (repo === undefined) return undefined;
  return repo.name ?? repo.location?.identity;
}

/**
 * The path part of a key, without any repository.
 *
 * @param ref - Any ref.
 */
function pathPart(ref: SousRef): string {
  switch (ref.kind) {
    case "repo":
      return ref.browsed === undefined ? "" : `tree/${ref.browsed}`;
    case "namespace":
      return ref.name;
    case "recipe":
      return ref.namespace === undefined ? ref.name : `${ref.namespace.name}/${ref.name}`;
    case "recipeFile":
      return `${pathPart(ref.recipe)}/${ref.path}`;
    case "variable": {
      const recipe = ref.recipe === undefined ? "" : `${pathPart(ref.recipe)}.`;
      return `${recipe}${ref.name}`;
    }
    case "envVar":
      return ref.name;
  }
}

/**
 * The canonical key of a ref, with its version range and query values left
 * off, so the same thing is never keyed twice under two spellings. A
 * repository qualifier is part of the key, because the same recipe name in two
 * repositories is two things.
 *
 * refKey(namespace("workflow")); // -> "workflow"
 * refKey(recipe("task-files", "workflow", "sous-recipes")); // -> "sous-recipes:workflow/task-files"
 * refKey(variable("apiUrl", recipe)); // -> "workflow/task-files.apiUrl"
 *
 * @param ref - Any ref.
 */
export function refKey(ref: SousRef): string {
  const repo = ref.kind === "envVar" ? undefined : repoPart(repoOf(ref));
  const rest = pathPart(ref);
  if (ref.kind === "repo") return repo === undefined ? rest : rest === "" ? repo : `${repo}:${rest}`;
  return repo === undefined ? rest : `${repo}:${rest}`;
}

/**
 * The key of a ref together with its kind, which is what tells a namespace
 * `workflow` from a repository `workflow` apart.
 *
 * @param ref - Any ref.
 */
export function refIdentity(ref: SousRef): string {
  return `${ref.kind} ${refKey(ref)}`;
}

/**
 * Writes the repository qualifier in front of what is named inside it: the
 * provider's canonical locator for a located repository, `name:` for a short
 * name.
 */
function qualified(
  repo: RepoRef | undefined,
  rest: string,
  providers: RepoProvider[]
): string {
  if (repo === undefined) return rest;
  if (repo.location !== undefined) {
    const { host, repoPath } = repo.location;
    const provider = providerById(repo.location.provider, providers);
    if (provider !== undefined && provider.id !== "local") {
      return provider.formatLocator(host, repoPath, rest);
    }
    return rest === "" ? repo.location.url : `${repo.location.url}/${rest}`;
  }
  if (repo.name === undefined) return rest;
  return rest === "" ? repo.name : `${repo.name}:${rest}`;
}

/**
 * The canonical written form of a ref, which is how sous prints it: the short
 * form for a short ref and each provider's own locator for a located one, then
 * the version range, then the query values.
 *
 * formatRef(parse("https://github.com/o/r/w/a@^1")[0]); // -> "github://o/r/w/a@^1"
 *
 * @param ref - Any ref.
 * @param providers - The providers that format locators. Defaults to the built-ins.
 */
export function formatRef(ref: SousRef, providers: RepoProvider[] = builtInProviders()): string {
  const body = qualified(ref.kind === "envVar" ? undefined : repoOf(ref), pathPart(ref), providers);
  const written =
    ref.kind === "recipe" || ref.kind === "recipeFile" || ref.kind === "repo"
      ? ref.range
      : undefined;
  const range = written === undefined ? "" : `@${written}`;
  const pairs = Object.entries(ref.vars ?? {}).map(
    ([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`
  );
  return `${body}${range}${pairs.length === 0 ? "" : `?${pairs.join("&")}`}`;
}

/**
 * What kind of thing a ref names, in a sentence.
 *
 * @param ref - Any ref.
 */
export function refKindLabel(ref: SousRef): string {
  return KIND_LABELS[ref.kind];
}

/**
 * Describes one ref in the words a person choosing between several needs: the
 * fully qualified name, and what it actually means.
 *
 * @param ref - A known ref, as a lookup returns it.
 */
export function describeRef(ref: SousRef): string {
  const summary = ref.description === undefined ? "" : `: ${ref.description}`;
  const key = refKey(ref);

  switch (ref.kind) {
    case "repo": {
      const where = ref.location?.url;
      return `${key}  (the repository '${ref.name ?? key}'${where === undefined ? "" : `, at ${where}`})`;
    }
    case "namespace":
      return (
        `${key}  (the whole namespace '${ref.name}' in the ` +
        `repository '${repoPart(ref.repo) ?? "unknown"}')`
      );
    case "recipe":
      return (
        `${key}  (the recipe '${ref.name}' in the namespace ` +
        `'${ref.namespace?.name ?? "unknown"}' of the repository ` +
        `'${repoPart(repoOf(ref)) ?? "unknown"}'${summary})`
      );
    case "recipeFile":
      return `${key}  (the file '${ref.path}' of the recipe '${pathPart(ref.recipe)}'${summary})`;
    case "variable":
      return (
        `${key}  (the variable '${ref.name}' of the recipe ` +
        `'${ref.recipe === undefined ? "unknown" : pathPart(ref.recipe)}'${summary})`
      );
    case "envVar": {
      const first = ref.variables?.[0];
      const answers =
        first === undefined
          ? ""
          : `answering '${first.name}' of the recipe '${first.recipe === undefined ? "unknown" : pathPart(first.recipe)}'`;
      return `${ref.name}  (the environment variable${answers === "" ? "" : ` ${answers}`}${summary})`;
    }
  }
}
