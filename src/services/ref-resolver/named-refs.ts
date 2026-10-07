/**
 * Namespaces and recipes by their stored names: what a lockfile, an index, a
 * config key and a manifest entry hold. A `NamedRef` is a namespace, or a
 * recipe with its namespace, and `shortKey` (in `pruners/rule-helpers.ts`) is
 * the `namespace` or `namespace/recipe` it is stored under.
 *
 * Callers with a stored key use `splitRecipeKey` and `namespaceOfKey`, which
 * read it through the resolver with `RefSource.Lockfile`, so a key is read by
 * the same code wherever it came from.
 */

import { ConfigError } from "../../lib/errors.js";
import { sharedRefResolver } from "./container.js";
import { locationOf } from "./parts.js";
import { RefSource } from "./source.js";
import type { NamespaceRef, RecipeRef, SousRef } from "./types.js";

/** A namespace, or a recipe that names its namespace. */
export type NamedRef = NamespaceRef | RecipeRef;

/**
 * True when a ref is a namespace or a recipe that names its namespace.
 *
 * @param ref - Any ref.
 */
export function isNamedRef(ref: SousRef): ref is NamedRef {
  return ref.kind === "namespace" || (ref.kind === "recipe" && ref.namespace !== undefined);
}

/**
 * A namespace ref, optionally inside a repository known by short name.
 *
 * @param name - The namespace.
 * @param repo - The repository's short name, when the ref is qualified by one.
 */
export function namespaceRef(name: string, repo?: string): NamespaceRef {
  return {
    kind: "namespace",
    name,
    ...(repo === undefined ? {} : { repo: { kind: "repo", name: repo } }),
  };
}

/**
 * A recipe ref with its namespace, optionally inside a repository known by
 * short name and with a version range.
 *
 * @param namespace - The recipe's namespace.
 * @param name - The recipe.
 * @param options - The repository's short name and the range, when there are any.
 */
export function recipeRef(
  namespace: string,
  name: string,
  options: { repo?: string; range?: string } = {}
): RecipeRef {
  return {
    kind: "recipe",
    name,
    namespace: namespaceRef(namespace, options.repo),
    ...(options.range === undefined ? {} : { range: options.range }),
  };
}

/**
 * The same namespace or recipe, qualified by a repository's short name. A
 * recipe holds its repository through its namespace.
 *
 * @param ref - A namespace or a recipe.
 * @param repo - The repository's short name; left undefined, the ref comes back as it is.
 */
export function withRepoName(ref: NamedRef, repo: string | undefined): NamedRef {
  if (repo === undefined) return ref;
  if (ref.kind === "namespace") return { ...ref, repo: { kind: "repo", name: repo } };
  return { ...ref, namespace: namespaceRef(ref.namespace?.name ?? "", repo) };
}

/**
 * The one reading of a ref that must name a namespace or a recipe by its short
 * form: a config key, a stored key, or a ref a caller has already settled.
 *
 * @param input - The ref as written.
 * @param from - Where it was written.
 * @throws A ConfigError when the place refuses it, or it names a location or reads several ways.
 */
export function parseNamedRef(input: string, from: RefSource = RefSource.CommandLine): NamedRef {
  const { refs } = sharedRefResolver().parse(input, from);
  const named = refs.filter((ref): ref is NamedRef => isNamedRef(ref) && locationOf(ref) === undefined);
  if (named.length === 1 && !refs.some((ref) => locationOf(ref) !== undefined)) return named[0]!;
  throw new ConfigError(
    `Invalid ref '${input}': this needs a namespace or a recipe named by its short form, such ` +
      `as 'workflow/alpha', and this ref names a location.`
  );
}

/** What a stored key was read as, by key. A key's reading never changes, and listings read every key many times. */
const storedKeys = new Map<string, { namespace: string; name?: string }>();

/**
 * Reads a stored key through the resolver, once per distinct key.
 *
 * @param key - A key sous stored.
 */
function readStoredKey(key: string): { namespace: string; name?: string } {
  const known = storedKeys.get(key);
  if (known !== undefined) return known;
  const parsed = parseNamedRef(key, RefSource.Lockfile);
  const read =
    parsed.kind === "namespace"
      ? { namespace: parsed.name }
      : { namespace: parsed.namespace!.name, name: parsed.name };
  storedKeys.set(key, read);
  return read;
}

/**
 * The namespace and name of a stored recipe key, `namespace/recipe`.
 *
 * splitRecipeKey("workflow/alpha"); // -> { namespace: "workflow", name: "alpha" }
 *
 * @param key - A key sous stored.
 */
export function splitRecipeKey(key: string): { namespace: string; name: string } {
  const { namespace, name } = readStoredKey(key);
  if (name === undefined) {
    throw new ConfigError(
      `Invalid ref '${key}': a recipe key names a namespace and a recipe.\n` +
        `  A stored key is written as 'namespace' or 'namespace/recipe'.`
    );
  }
  return { namespace, name };
}

/**
 * The namespace a stored key belongs to: the key itself for a namespace, and
 * its namespace for a recipe.
 *
 * namespaceOfKey("workflow/alpha"); // -> "workflow"
 *
 * @param key - A key sous stored.
 */
export function namespaceOfKey(key: string): string {
  return readStoredKey(key).namespace;
}
