/**
 * The ref parser.
 *
 * A "ref" is how everything in the Repositories system names a namespace or a
 * recipe: on the command line, in a project's subscriptions, and in a recipe
 * manifest's `depends` and `subscribes` lists. The grammar is deliberately
 * small and prefix-free:
 *
 *     ref := [ repo ":" ] namespace [ "/" recipe [ "@" range ] ]
 *
 *     workflow                              a whole namespace
 *     workflow/task-files                   one recipe, any version
 *     workflow/task-files@^1.2.0            one recipe, constrained
 *     sous-recipes:workflow/task-files      the same recipe in a named repo
 *
 * The repo qualifier is only needed when the same ref resolves in more than one
 * added repo; refs otherwise resolve across every added repo's cached index.
 * A version range applies to a recipe, never to a namespace, because namespaces
 * are not versioned.
 */

import semver from "semver";
import { ConfigError } from "../errors.js";
import {
  NAMESPACE_NAME_PATTERN,
  RECIPE_NAME_PATTERN,
  REPO_NAME_PATTERN,
} from "./formats/patterns.js";

/** A parsed ref. `recipe` is absent for a namespace ref; `range` needs a recipe. */
export type ParsedRef = {
  /** The repo short name from a `repo:` qualifier, when one was given. */
  repo?: string;
  /** The namespace. Always present. */
  namespace: string;
  /** The recipe name, when the ref names a recipe rather than a whole namespace. */
  recipe?: string;
  /** The semantic version range, when one was given. Only legal with a recipe. */
  range?: string;
};

/** The one-line reminder appended to every ref error. */
const SYNTAX_HELP =
  "A ref is written as 'namespace', 'namespace/recipe', 'namespace/recipe@<range>' or " +
  "'repo:namespace/recipe@<range>'.";

/** Builds a ConfigError that quotes the offending input and shows the grammar. */
function refError(input: string, problem: string): ConfigError {
  return new ConfigError(`Invalid ref '${input}': ${problem}\n  ${SYNTAX_HELP}`);
}

/**
 * Parses a ref string into its parts, throwing a ConfigError that quotes the
 * input and shows the grammar when it does not fit.
 *
 * @param input - The ref as written by a user or a manifest.
 */
export function parseRef(input: string): ParsedRef {
  if (typeof input !== "string") {
    throw refError(String(input), "a ref must be a string.");
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw refError(input, "a ref must not be empty.");
  }

  if (trimmed.startsWith("@")) {
    throw refError(
      input,
      "refs take no '@' prefix. The '@' character introduces a version range only, " +
        "as in 'workflow/task-files@^1.2.0'."
    );
  }
  if (trimmed.startsWith("~")) {
    throw refError(
      input,
      "refs take no '~' prefix. The '~' sigil belongs to template include lines " +
        "('@~workflow/file.md'); a ref itself is written without it."
    );
  }

  // Split the version range off first, so the rest is pure path and qualifier.
  let body = trimmed;
  let range: string | undefined;
  const atIndex = body.indexOf("@");
  if (atIndex !== -1) {
    if (body.indexOf("@", atIndex + 1) !== -1) {
      throw refError(input, "a ref may carry at most one '@' version range.");
    }
    range = body.slice(atIndex + 1).trim();
    body = body.slice(0, atIndex);
    if (range.length === 0) {
      throw refError(input, "the '@' is not followed by a version range.");
    }
  }

  // Then the repo qualifier.
  let repo: string | undefined;
  const colonIndex = body.indexOf(":");
  if (colonIndex !== -1) {
    if (body.indexOf(":", colonIndex + 1) !== -1) {
      throw refError(input, "a ref may carry at most one 'repo:' qualifier.");
    }
    repo = body.slice(0, colonIndex);
    body = body.slice(colonIndex + 1);
    if (repo.length === 0) {
      throw refError(input, "the repo qualifier before ':' is empty.");
    }
    if (!REPO_NAME_PATTERN.test(repo)) {
      throw refError(
        input,
        `the repo qualifier '${repo}' must be lowercase kebab-case: a letter, then ` +
          "letters, digits or hyphens."
      );
    }
  }

  // What is left is the namespace, optionally followed by a recipe.
  const segments = body.split("/");
  if (segments.length > 2) {
    throw refError(
      input,
      "a ref has at most two path segments, a namespace and a recipe."
    );
  }

  const [namespace, recipe] = segments;
  if (namespace === undefined || namespace.length === 0) {
    throw refError(input, "the namespace is empty.");
  }
  if (!NAMESPACE_NAME_PATTERN.test(namespace)) {
    throw refError(
      input,
      `the namespace '${namespace}' must be lowercase kebab-case: a letter, then ` +
        "letters, digits or hyphens."
    );
  }

  if (recipe !== undefined) {
    if (recipe.length === 0) {
      throw refError(input, "the recipe name after '/' is empty.");
    }
    if (!RECIPE_NAME_PATTERN.test(recipe)) {
      throw refError(
        input,
        `the recipe name '${recipe}' must be lowercase kebab-case: a letter, then ` +
          "letters, digits or hyphens."
      );
    }
  }

  if (range !== undefined) {
    if (recipe === undefined) {
      throw refError(
        input,
        "a version range applies to a recipe, and namespaces are not versioned. " +
          "Name a recipe, as in 'workflow/task-files@^1.2.0'."
      );
    }
    if (semver.validRange(range) === null) {
      throw refError(
        input,
        `'${range}' is not a version range. Ranges follow npm's rules, such as ` +
          "'^1.2.0', '~2.1', '>=1.0.0 <2.0.0' or '*'."
      );
    }
  }

  const parsed: ParsedRef = { namespace };
  if (repo !== undefined) parsed.repo = repo;
  if (recipe !== undefined) parsed.recipe = recipe;
  if (range !== undefined) parsed.range = range;
  return parsed;
}

/**
 * Parses a ref, returning undefined instead of throwing. Use this where a bad
 * ref is reported through another mechanism, such as a zod issue.
 *
 * @param input - The ref as written.
 */
export function tryParseRef(input: string): ParsedRef | undefined {
  try {
    return parseRef(input);
  } catch {
    return undefined;
  }
}

/**
 * True when the input parses as a ref.
 *
 * @param input - The ref as written.
 */
export function isValidRef(input: string): boolean {
  return tryParseRef(input) !== undefined;
}

/**
 * Renders a parsed ref back into its canonical written form. Round-trips with
 * parseRef, apart from surrounding whitespace.
 *
 * @param parsed - The ref parts.
 */
export function formatRef(parsed: ParsedRef): string {
  const qualifier = parsed.repo === undefined ? "" : `${parsed.repo}:`;
  const recipe = parsed.recipe === undefined ? "" : `/${parsed.recipe}`;
  const range = parsed.range === undefined ? "" : `@${parsed.range}`;
  return `${qualifier}${parsed.namespace}${recipe}${range}`;
}

/**
 * The ref's identity, with the repo qualifier and the version range dropped:
 * `namespace` for a namespace ref, `namespace/recipe` for a recipe ref. This is
 * the key everything else is stored under (subscriptions, the index, the
 * lockfile), so the same recipe is never recorded twice under two spellings.
 *
 * @param parsed - The ref parts.
 */
export function refKey(parsed: ParsedRef): string {
  return parsed.recipe === undefined
    ? parsed.namespace
    : `${parsed.namespace}/${parsed.recipe}`;
}

/** True when the ref names a whole namespace rather than a single recipe. */
export function isNamespaceRef(parsed: ParsedRef): boolean {
  return parsed.recipe === undefined;
}
