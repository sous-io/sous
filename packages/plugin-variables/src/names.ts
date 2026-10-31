/**
 * Variable names and their environment spellings.
 *
 * Every environment name here is generated, then looked up. Nothing parses a name back into the
 * scope that made it: `_` is both the delimiter and a legal character, so
 * `SOUS_VAR_MISC_STUFF_API_URL` could be split in several places. When a generated name collides
 * with something else, a variable mapping binds a chosen name to one variable instead.
 */

import type { VariablesNames } from "./types.js";

/** The prefix every generated answer name carries. */
export const ENV_PREFIX = "SOUS_VAR_";

/** A well-formed variable name: camelCase, starting with a lowercase letter. */
export const VARIABLE_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/;

/** A well-formed environment variable name: upper snake case. */
export const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * A camelCase or kebab-case identifier in upper snake case.
 *
 * ```ts
 * toUpperSnake("apiBaseUrl");       // "API_BASE_URL"
 * toUpperSnake("githubAPIToken");   // "GITHUB_API_TOKEN"
 * toUpperSnake("task-files");       // "TASK_FILES"
 * ```
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

/** The shared name, which answers a variable of this name for every recipe: `SOUS_VAR_API_URL`. */
export function sharedName(variable: string): string {
    return `${ENV_PREFIX}${toUpperSnake(variable)}`;
}

/** The recipe-scoped name, the most specific: `SOUS_VAR_MISC_STUFF_API_URL`. */
export function recipeScopedName(namespace: string, recipe: string, variable: string): string {
    return `${ENV_PREFIX}${toUpperSnake(namespace)}_${toUpperSnake(recipe)}_${toUpperSnake(variable)}`;
}

/** The namespace-scoped name, for every recipe in one namespace: `SOUS_VAR_MISC_API_URL`. */
export function namespaceScopedName(namespace: string, variable: string): string {
    return `${ENV_PREFIX}${toUpperSnake(namespace)}_${toUpperSnake(variable)}`;
}

/**
 * The name a definition is answered by with nothing else said: its own `env` when its author set
 * one (so a recipe can bind `GITHUB_TOKEN`), and the shared name otherwise. New answers are written
 * under it.
 */
export function bareName(definition: { readonly name: string; readonly env?: string }): string {
    return definition.env ?? sharedName(definition.name);
}

/** The `variables.names` service. It holds no state, so one object serves every config. */
export const variablesNames: VariablesNames = {
    envPrefix: ENV_PREFIX,
    toUpperSnake,
    sharedName,
    recipeScopedName,
    namespaceScopedName,
    bareName,
    isVariableName: (text) => VARIABLE_NAME_PATTERN.test(text),
    isEnvName: (text) => ENV_NAME_PATTERN.test(text),
};
