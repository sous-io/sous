/**
 * What a ref is: plain data, never a class instance, so it survives a JSON
 * round trip, can be compared structurally and can be extended by a plugin.
 *
 * A ref is a discriminated union on `kind`. Every kind with parents nests them:
 * a recipe file carries its recipe, which carries its namespace, which carries
 * the repository qualifier it was written with. A parent is optional wherever
 * the written form may leave it out (a bare `task-files` is a recipe whose
 * namespace is unknown), and a parent is a candidate of its own only when the
 * written text could mean it.
 *
 * Globs are a flag on the ref (`glob`), not a kind of their own: a glob is a
 * way of writing the name or path of a namespace, a recipe or a file, and the
 * kind is what a lookup needs to know where to search. `glob` is true when any
 * name or path part of the ref (a parent's included) is a pattern.
 */

import type { ProviderId } from "../../lib/repos/providers/index.js";

/** Where a ref says a repository lives. */
export type RefLocation = {
  /** The provider that reads the location. */
  provider: ProviderId;
  /** The host, such as `github.com`. */
  host: string;
  /** The repository's path on the host, such as `sous-io/sous-recipes`. */
  repoPath: string;
  /** The repository's canonical identity, as the store and the lockfile key it. */
  identity: string;
  /** The repository's HTTPS URL, which is what adding it is handed. */
  url: string;
};

/** What every ref may carry. */
export type RefBase = {
  /** True when any name or path part of the ref is a glob pattern. */
  glob?: true;
  /** The `?name=value` pairs the ref was written with, percent-decoded. */
  vars?: Record<string, string>;
  /**
   * What the publisher says the thing is, in one line. Never read from written
   * text; a lookup fills it in so a person choosing between matches can tell
   * them apart.
   */
  description?: string;
};

/**
 * A repository: named by the short name a project gave it, by where it lives,
 * or both. As the parent of another ref it is the repository qualifier.
 */
export type RepoRef = RefBase & {
  kind: "repo";
  /** The project's short name for the repository (may be a glob). */
  name?: string;
  /** Where the repository lives, when the ref said so. */
  location?: RefLocation;
  /** A branch or tag, once a lookup has told it apart from the path after it. */
  revision?: string;
  /**
   * A folder or file path copied from a host's file view, branch still in
   * front of it (`main/recipes/workflow/alpha`). Which recipe or namespace it
   * is, and where the branch ends, only the repository's index can say.
   */
  browsed?: string;
  /** The version range a browsed path was written with; it applies to the recipe it settles to. */
  range?: string;
};

/** A namespace published by a repository. */
export type NamespaceRef = RefBase & {
  kind: "namespace";
  /** The namespace name (may be a glob). */
  name: string;
  /** The repository qualifier, when one was written. */
  repo?: RepoRef;
  /** True when the namespace was spelled out as `namespace/*`. */
  wildcard?: true;
};

/** A recipe published in a namespace. */
export type RecipeRef = RefBase & {
  kind: "recipe";
  /** The recipe name (may be a glob). */
  name: string;
  /** The namespace, when the ref named it. */
  namespace?: NamespaceRef;
  /** The repository qualifier, set here only when there is no namespace to hold it. */
  repo?: RepoRef;
  /** The semantic version range, when one was given. */
  range?: string;
};

/** A file inside a recipe. */
export type RecipeFileRef = RefBase & {
  kind: "recipeFile";
  /** The path inside the recipe, `/`-separated (may be a glob). */
  path: string;
  /** The recipe holding it. */
  recipe: RecipeRef;
  /** The semantic version range, when one was given. */
  range?: string;
};

/** A variable a recipe declares, written `namespace/recipe.variableName`. */
export type VariableRef = RefBase & {
  kind: "variable";
  /** The variable's own name, as its author wrote it (may be a glob). */
  name: string;
  /** The recipe declaring it, when the ref named it. */
  recipe?: RecipeRef;
  /** The repository qualifier, set here only when there is no recipe to hold it. */
  repo?: RepoRef;
};

/** An environment variable name, held whole: it is never split into scopes. */
export type EnvVarRef = RefBase & {
  kind: "envVar";
  /** The name, exactly as written. */
  name: string;
  /** The variables this name answers, once a lookup has said. */
  variables?: VariableRef[];
};

/** Anything a written ref can name. */
export type SousRef =
  | RepoRef
  | NamespaceRef
  | RecipeRef
  | RecipeFileRef
  | VariableRef
  | EnvVarRef;

/** Every kind, in the order matches of equal specificity are listed in. */
export const REF_KINDS = [
  "repo",
  "namespace",
  "recipe",
  "recipeFile",
  "variable",
  "envVar",
] as const;

/** One kind of ref. */
export type RefKind = (typeof REF_KINDS)[number];

/** What each kind is called in a sentence. */
export const KIND_LABELS: Record<RefKind, string> = {
  repo: "repository",
  namespace: "namespace",
  recipe: "recipe",
  recipeFile: "recipe file",
  variable: "variable",
  envVar: "environment variable",
};
