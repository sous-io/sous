/**
 * The kinds of thing a reference on the command line can name.
 *
 * Every sous command that takes a `<ref>` or a `[NAME]` argument is naming one
 * of these five things, and each command accepts only the kinds that make sense
 * for it: `sous subscribe` accepts a namespace or a recipe, `sous vars ask`
 * accepts all five. The scope list a command passes to `findReference` is
 * therefore part of that command's contract, and it is the only thing that
 * differs between one command's resolution and another's.
 */

/** One kind of thing a reference can name. */
export enum SousScope {
  /** A repository this project trusts, named by its short name. */
  Repository = "repository",
  /** A namespace published by a repository. */
  Namespace = "namespace",
  /** A recipe published in a namespace. */
  Recipe = "recipe",
  /** A variable declared by a recipe, named as the recipe's author named it. */
  VariableName = "variableName",
  /** An environment variable name that answers a variable. */
  EnvVarName = "envVarName",
}

/**
 * Every scope, in the order matches of equal specificity are listed in. It is
 * the order the one-word ref search has always used (a whole namespace before
 * the recipes inside it), widened to the other three kinds: the broadest thing
 * a word could have meant is offered first, and the environment variable names
 * (the least likely reading of a plain word) come last.
 */
export const SCOPE_ORDER: readonly SousScope[] = [
  SousScope.Repository,
  SousScope.Namespace,
  SousScope.Recipe,
  SousScope.VariableName,
  SousScope.EnvVarName,
] as const;

/** Every scope, for a command that accepts anything a reference can name. */
export const ALL_SCOPES: readonly SousScope[] = SCOPE_ORDER;

/** What each scope is called in a sentence. */
export const SCOPE_LABELS: Record<SousScope, string> = {
  [SousScope.Repository]: "repository",
  [SousScope.Namespace]: "namespace",
  [SousScope.Recipe]: "recipe",
  [SousScope.VariableName]: "variable",
  [SousScope.EnvVarName]: "environment variable",
};

/**
 * Where a scope sits in the listing order.
 *
 * @param scope - The scope to rank.
 */
export function scopeRank(scope: SousScope): number {
  const rank = SCOPE_ORDER.indexOf(scope);
  return rank === -1 ? SCOPE_ORDER.length : rank;
}
