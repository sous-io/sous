/**
 * Environment variable names for recipe variable answers.
 *
 * Every name here is GENERATED and then LOOKED UP. Nothing in sous ever parses
 * a name back into the scope that produced it: `_` is both the delimiter and a
 * legal identifier character, so `SOUS_VAR_MISC_STUFF_API_URL` could be split
 * in several places and no parse would be trustworthy. When a generated name
 * collides with something else, a mapping record (see `mappings.ts`) binds an
 * arbitrary name to one fully qualified variable instead.
 */

import type { VariableDefinition } from "../repos/formats/recipe-manifest.js";

/** The prefix every generated answer name carries. */
export const ENV_PREFIX = "SOUS_VAR_";

/**
 * Converts a camelCase or kebab-case identifier to upper snake case.
 *
 * @param name - The identifier, such as `apiBaseUrl` or `task-files`.
 * @returns The upper snake case form, such as `API_BASE_URL` or `TASK_FILES`.
 */
export function toUpperSnake(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[-\s.]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toUpperCase();
}

/**
 * The default environment variable name for a variable, derived from its
 * camelCase name: `apiUrl` becomes `SOUS_VAR_API_URL`. This is the same string
 * as the shared rung of the resolution ladder.
 *
 * @param variableName - The variable's camelCase name.
 */
export function deriveEnvName(variableName: string): string {
  return `${ENV_PREFIX}${toUpperSnake(variableName)}`;
}

/**
 * The recipe-scoped name: the most specific generated rung, naming both the
 * namespace and the recipe. `misc` plus `stuff` plus `apiUrl` becomes
 * `SOUS_VAR_MISC_STUFF_API_URL`.
 *
 * @param namespace - The recipe's namespace.
 * @param recipe - The recipe's name.
 * @param variableName - The variable's camelCase name.
 */
export function recipeScopedName(
  namespace: string,
  recipe: string,
  variableName: string
): string {
  return `${ENV_PREFIX}${toUpperSnake(namespace)}_${toUpperSnake(recipe)}_${toUpperSnake(
    variableName
  )}`;
}

/**
 * The namespace-scoped name, which answers the same variable for every recipe
 * in one namespace. `misc` plus `apiUrl` becomes `SOUS_VAR_MISC_API_URL`.
 *
 * @param namespace - The recipe's namespace.
 * @param variableName - The variable's camelCase name.
 */
export function namespaceScopedName(namespace: string, variableName: string): string {
  return `${ENV_PREFIX}${toUpperSnake(namespace)}_${toUpperSnake(variableName)}`;
}

/**
 * The shared name, which answers a variable of this name for every recipe that
 * declares one. `apiUrl` becomes `SOUS_VAR_API_URL`.
 *
 * @param variableName - The variable's camelCase name.
 */
export function sharedName(variableName: string): string {
  return deriveEnvName(variableName);
}

/**
 * The bare declared name: the definition's own `env` field when its author set
 * one (so a recipe can bind an existing variable such as `GITHUB_TOKEN`), and
 * the shared form otherwise. This is also the name a new answer is written
 * under.
 *
 * @param definition - The variable definition.
 */
export function bareName(definition: VariableDefinition): string {
  return definition.env ?? sharedName(definition.name);
}
