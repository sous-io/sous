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
 * Where a ref was written. `parseRef` reads every form wherever a ref comes
 * from, and the place decides which of those forms it allows: a refused form
 * is an error saying what to write there instead.
 */
export enum RefSource {
  /**
   * A ref typed on the command line. Every form is allowed: a bare name, a
   * namespace and recipe, a `repo:` qualifier, a version range, a
   * provider-scheme locator, an HTTPS, SSH or scheme-less URL, and a browser
   * URL copied from a host's file view. Names may be written in any case.
   */
  CommandLine = "commandLine",
  /**
   * A subscription key in a config layer. Only the stored form is allowed:
   * `namespace` or `namespace/recipe`, lowercase. The repository a
   * subscription resolves into is recorded in the lockfile, and its range in
   * the entry's own `range` field.
   */
  Config = "config",
  /**
   * An entry of a recipe manifest's `depends` or `subscribes` list. A bare ref
   * names a recipe in the same repository; every locator and URL form names
   * one in another repository. A `repo:` qualifier is refused, because it is
   * one project's private name for a repository, and so is a local path.
   */
  Manifest = "manifest",
  /**
   * A key sous wrote itself: the lockfile, the index and the store. Only the
   * canonical `namespace` or `namespace/recipe` is allowed.
   */
  Lockfile = "lockfile",
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
