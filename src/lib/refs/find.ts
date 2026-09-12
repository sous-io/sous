/**
 * Working out what a word on the command line names.
 *
 * Sous commands take a reference where a person would say a name: `sous
 * subscribe task-files`, `sous namespace show workflow`, `sous vars ask apiUrl`.
 * One module settles what such a word means, for every command, so a reference
 * that resolves in one place resolves the same way everywhere.
 *
 * A reference may be written at any level of qualification, and the fully
 * qualified spelling is always accepted:
 *
 *     sous-recipes                              a repository
 *     sous-recipes:workflow                     a namespace, fully qualified
 *     workflow                                  the same namespace, bare
 *     sous-recipes:workflow/task-files          a recipe, fully qualified
 *     workflow/task-files                       the same recipe, partly qualified
 *     task-files                                the same recipe, bare
 *     workflow/task-files.taskFileRoot          a variable, partly qualified
 *     taskFileRoot                              the same variable, bare
 *     SOUS_VAR_TASK_FILE_ROOT                   the environment variable answering it
 *
 * Matching is case-sensitive, because every identifier in sous is (namespaces
 * and recipes are lowercase kebab-case, variables are camelCase, environment
 * variable names are upper snake case), and a case-insensitive search would
 * report a variable and its own environment variable name as the same thing.
 *
 * The order matches come back in is part of the contract, because it is the
 * order they are offered in and the one `--accept-first` picks from. Matches
 * are sorted by how qualified the spelling that matched was (a fully qualified
 * reference first, then a partly qualified one, then a bare name, and an
 * environment variable name last), then by scope in the order `SCOPE_ORDER`
 * documents, then by repository in search order, then alphabetically by
 * namespace, recipe and variable.
 */

import type { IndexFile } from "../repos/formats/index-file.js";
import type { ParsedRef } from "../repos/ref.js";
import type { DefinedVariable } from "../vars/definition-source.js";
import { variableCandidates, type LadderContext } from "../vars/ladder.js";
import { bareName } from "../vars/names.js";
import { SCOPE_LABELS, SousScope, scopeRank } from "./scopes.js";

// --- What the search reads ----------------------------------------------------------------------

/** One namespace a reference could name. */
export type ReferenceNamespace = {
  /** The namespace name. */
  name: string;
  /** Its one-paragraph summary, when the index carries one. */
  description?: string;
};

/** One recipe a reference could name. */
export type ReferenceRecipe = {
  /** The namespace publishing it. */
  namespace: string;
  /** The recipe name. */
  name: string;
  /** Its one-paragraph summary, when the index carries one. */
  description?: string;
};

/** One repository a reference could name, and what it publishes. */
export type ReferenceRepo = {
  /** The short name this project calls it. */
  name: string;
  /** Where it lives, as the project's config records it. */
  url?: string;
  /** Every namespace it publishes. */
  namespaces: ReferenceNamespace[];
  /** Every recipe it publishes. */
  recipes: ReferenceRecipe[];
};

/**
 * Everything a reference resolves against. Each part is optional, because a
 * command supplies only what it can see: a browsing command has repositories
 * and their indexes, `sous vars ask --file` has definitions and no repository
 * at all.
 */
export type ReferenceContext = {
  /**
   * The repositories to search, in the order their matches should be listed:
   * the built-in repository first, then the ones the config names, in config
   * order.
   */
  repos?: ReferenceRepo[];
  /** The variable definitions in play, with the recipe that published each. */
  variables?: DefinedVariable[];
  /**
   * The environment layers, which decide which generated environment variable
   * names are in use. Without it only a definition's declared `env` name is
   * searched.
   */
  ladder?: LadderContext;
};

// --- What the search answers --------------------------------------------------------------------

/**
 * How qualified the spelling that matched was. Lower is more specific, and the
 * listing order follows it.
 */
export enum Qualification {
  /** The reference named the whole identity, repository included. */
  Full = 0,
  /** The reference named part of the identity, such as `namespace/recipe`. */
  Partial = 1,
  /** The reference was a bare name. */
  Bare = 2,
  /** The reference was an environment variable name. */
  EnvName = 3,
}

/** One thing a reference could have meant. */
export type ReferenceMatch = {
  /** What kind of thing it is. */
  scope: SousScope;
  /**
   * The fully qualified name of it: `repo`, `repo:namespace`,
   * `repo:namespace/recipe`, or `repo:namespace/recipe.variable`. Two matches
   * never share a key within one scope, so it is safe to compare and to print.
   */
  key: string;
  /** The short name of the thing itself, without any qualifier. */
  label: string;
  /** What it is, in one line: a description, a prompt, or where it lives. */
  detail?: string;
  /** The repository it belongs to, when it has one. */
  repo?: string;
  /** The namespace it is, or the one it lives in. */
  namespace?: string;
  /** The recipe it is, or the one that declares it. */
  recipe?: string;
  /** The variable it is, or the one an environment variable name answers. */
  variable?: string;
  /** The environment variable name, when the reference named one. */
  envName?: string;
  /** How qualified the spelling that matched was. */
  qualification: Qualification;
};

// --- The search ---------------------------------------------------------------------------------

/**
 * Every meaning a reference could have, in the documented order.
 *
 * Nothing is fetched and nothing is asked: this reads the context it is handed
 * and returns what matched. An empty result means the reference named nothing
 * the caller can see; one result is the answer; several are offered to the
 * caller by `pickReference`.
 *
 * @param search - The reference exactly as it was written.
 * @param scopes - The kinds of thing this command accepts.
 * @param context - The repositories, definitions and environment layers to search.
 */
export function findReference(
  search: string,
  scopes: readonly SousScope[],
  context: ReferenceContext
): ReferenceMatch[] {
  const wanted = new Set(scopes);
  const term = search.trim();
  if (term.length === 0) return [];

  const matches: ReferenceMatch[] = [];
  const repoOrder = new Map((context.repos ?? []).map((repo, position) => [repo.name, position]));

  for (const repo of context.repos ?? []) {
    if (wanted.has(SousScope.Repository) && term === repo.name) {
      matches.push({
        scope: SousScope.Repository,
        key: repo.name,
        label: repo.name,
        repo: repo.name,
        qualification: Qualification.Full,
        ...(repo.url === undefined ? {} : { detail: repo.url }),
      });
    }

    if (wanted.has(SousScope.Namespace)) {
      for (const namespace of repo.namespaces) {
        const key = `${repo.name}:${namespace.name}`;
        const qualification = qualificationOf(term, [
          [key, Qualification.Full],
          [namespace.name, Qualification.Bare],
        ]);
        if (qualification === undefined) continue;
        matches.push({
          scope: SousScope.Namespace,
          key,
          label: namespace.name,
          repo: repo.name,
          namespace: namespace.name,
          qualification,
          ...(namespace.description === undefined ? {} : { detail: namespace.description }),
        });
      }
    }

    if (wanted.has(SousScope.Recipe)) {
      for (const recipe of repo.recipes) {
        const key = `${repo.name}:${recipe.namespace}/${recipe.name}`;
        const qualification = qualificationOf(term, [
          [key, Qualification.Full],
          [`${recipe.namespace}/${recipe.name}`, Qualification.Partial],
          [`${repo.name}:${recipe.name}`, Qualification.Partial],
          [recipe.name, Qualification.Bare],
        ]);
        if (qualification === undefined) continue;
        matches.push({
          scope: SousScope.Recipe,
          key,
          label: recipe.name,
          repo: repo.name,
          namespace: recipe.namespace,
          recipe: recipe.name,
          qualification,
          ...(recipe.description === undefined ? {} : { detail: recipe.description }),
        });
      }
    }
  }

  if (wanted.has(SousScope.VariableName) || wanted.has(SousScope.EnvVarName)) {
    for (const defined of context.variables ?? []) {
      const key = variableReferenceKey(defined);
      const { repo, namespace, name: recipe } = defined.recipe;
      const variable = defined.definition.name;

      if (wanted.has(SousScope.VariableName)) {
        const qualification = qualificationOf(term, [
          [key, Qualification.Full],
          [`${namespace}/${recipe}.${variable}`, Qualification.Partial],
          [`${recipe}.${variable}`, Qualification.Partial],
          [`${repo}:${variable}`, Qualification.Partial],
          [variable, Qualification.Bare],
        ]);
        if (qualification !== undefined) {
          matches.push({
            scope: SousScope.VariableName,
            key,
            label: variable,
            repo,
            namespace,
            recipe,
            variable,
            qualification,
            detail: defined.definition.prompt,
          });
          continue;
        }
      }

      if (wanted.has(SousScope.EnvVarName) && environmentNamesFor(defined, context).has(term)) {
        matches.push({
          scope: SousScope.EnvVarName,
          key,
          label: term,
          repo,
          namespace,
          recipe,
          variable,
          envName: term,
          qualification: Qualification.EnvName,
          detail: defined.definition.prompt,
        });
      }
    }
  }

  return sortMatches(matches, repoOrder);
}

/**
 * The repository a reference names.
 *
 * @param search - The reference exactly as it was written.
 * @param context - What to search.
 */
export function findRepository(
  search: string,
  context: ReferenceContext
): ReferenceMatch[] {
  return findReference(search, [SousScope.Repository], context);
}

/**
 * The namespace a reference names, bare or written as `repository:namespace`.
 *
 * @param search - The reference exactly as it was written.
 * @param context - What to search.
 */
export function findNamespace(search: string, context: ReferenceContext): ReferenceMatch[] {
  return findReference(search, [SousScope.Namespace], context);
}

/**
 * The recipe a reference names, at any level of qualification.
 *
 * @param search - The reference exactly as it was written.
 * @param context - What to search.
 */
export function findRecipe(search: string, context: ReferenceContext): ReferenceMatch[] {
  return findReference(search, [SousScope.Recipe], context);
}

/**
 * The variable a reference names, by its own name or by the name of an
 * environment variable that answers it.
 *
 * @param search - The reference exactly as it was written.
 * @param context - What to search.
 */
export function findVariable(search: string, context: ReferenceContext): ReferenceMatch[] {
  return findReference(search, [SousScope.VariableName, SousScope.EnvVarName], context);
}

// --- Describing what was found ------------------------------------------------------------------

/**
 * Describes one match in the words a person choosing between them needs: the
 * fully qualified name, and what it actually means.
 *
 * @param match - The match to describe.
 */
export function describeReference(match: ReferenceMatch): string {
  const summary = match.detail === undefined ? "" : `: ${match.detail}`;

  switch (match.scope) {
    case SousScope.Repository:
      return (
        `${match.key}  (the repository '${match.repo}'` +
        `${match.detail === undefined ? "" : `, at ${match.detail}`})`
      );
    case SousScope.Namespace:
      return (
        `${match.key}  (the whole namespace '${match.namespace}' in the ` +
        `repository '${match.repo}')`
      );
    case SousScope.Recipe:
      return (
        `${match.key}  (the recipe '${match.recipe}' in the namespace ` +
        `'${match.namespace}' of the repository '${match.repo}'${summary})`
      );
    case SousScope.VariableName:
      return (
        `${match.key}  (the variable '${match.variable}' of the recipe ` +
        `'${match.namespace}/${match.recipe}'${summary})`
      );
    case SousScope.EnvVarName:
      return (
        `${match.envName}  (the environment variable answering '${match.variable}' ` +
        `of the recipe '${match.namespace}/${match.recipe}'${summary})`
      );
  }
}

/**
 * The plain-language name of what a match is, for a sentence that has to say
 * what kind of thing was found.
 *
 * @param match - The match to name.
 */
export function referenceKindLabel(match: ReferenceMatch): string {
  return SCOPE_LABELS[match.scope];
}

// --- Building a context -------------------------------------------------------------------------

/**
 * Turns cached repository indexes into the repositories a reference searches,
 * in the order they were given.
 *
 * @param repoOrder - The repository short names, in search order.
 * @param indexes - Each repository's cached index, keyed by short name.
 */
export function referenceReposFromIndexes(
  repoOrder: readonly string[],
  indexes: Map<string, IndexFile>,
  urls: Record<string, string | undefined> = {}
): ReferenceRepo[] {
  const repos: ReferenceRepo[] = [];

  for (const name of repoOrder) {
    const index = indexes.get(name);
    if (index === undefined) continue;

    const namespaces: ReferenceNamespace[] = Object.entries(index.namespaces).map(
      ([namespace, declared]) => ({
        name: namespace,
        ...(declared?.description === undefined ? {} : { description: declared.description }),
      })
    );

    const recipes: ReferenceRecipe[] = [];
    for (const [key, recipe] of Object.entries(index.recipes)) {
      const slash = key.indexOf("/");
      if (slash === -1) continue;
      recipes.push({
        namespace: key.slice(0, slash),
        name: key.slice(slash + 1),
        ...(recipe.description === undefined ? {} : { description: recipe.description }),
      });
    }

    const url = urls[name];
    repos.push({ name, namespaces, recipes, ...(url === undefined ? {} : { url }) });
  }

  return repos;
}

/**
 * The repositories, namespaces and recipes the variable definitions in play
 * belong to, derived from the definitions themselves.
 *
 * This is the context a variables command searches: a namespace that publishes
 * no variable this project holds has no questions to ask, so naming it would
 * resolve to an empty set of questions rather than to an answer. Deriving the
 * context from the definitions also means `sous vars ask --file` resolves
 * references exactly as a subscribed project does.
 *
 * @param variables - The variable definitions in play.
 * @param ladder - The environment layers, for environment variable names.
 */
export function referenceContextFromVariables(
  variables: DefinedVariable[],
  ladder?: LadderContext
): ReferenceContext {
  const repos = new Map<string, ReferenceRepo>();

  for (const defined of variables) {
    const { repo: repoName, namespace, name: recipe } = defined.recipe;

    let repo = repos.get(repoName);
    if (repo === undefined) {
      repo = { name: repoName, namespaces: [], recipes: [] };
      repos.set(repoName, repo);
    }

    if (!repo.namespaces.some((entry) => entry.name === namespace)) {
      repo.namespaces.push({ name: namespace });
    }
    if (!repo.recipes.some((entry) => entry.namespace === namespace && entry.name === recipe)) {
      repo.recipes.push({ namespace, name: recipe });
    }
  }

  return {
    repos: [...repos.values()],
    variables,
    ...(ladder === undefined ? {} : { ladder }),
  };
}

/**
 * The fully qualified name of one variable: `repo:namespace/recipe.variable`.
 * It is what a reference to a variable resolves to, and what a command hands
 * back to the asking machinery when it has decided which variables to ask.
 *
 * @param defined - The definition and the recipe that published it.
 */
export function variableReferenceKey(defined: DefinedVariable): string {
  const { repo, namespace, name } = defined.recipe;
  return `${repo}:${namespace}/${name}.${defined.definition.name}`;
}

// --- Turning a match back into a ref --------------------------------------------------------------

/**
 * Turns a chosen match into a parsed ref, carrying over the version range the
 * original ref asked for. The repository qualifier is kept, so what gets
 * resolved is exactly the match that was chosen and not another repository's
 * recipe of the same name.
 *
 * @param match - The match that was chosen.
 * @param original - The ref as the user wrote it.
 */
export function referenceToRef(match: ReferenceMatch, original: ParsedRef): ParsedRef {
  return {
    ...(match.repo === undefined ? {} : { repo: match.repo }),
    namespace: match.namespace ?? original.namespace,
    ...(match.recipe === undefined ? {} : { recipe: match.recipe }),
    ...(original.range === undefined ? {} : { range: original.range }),
  };
}

// --- The pieces -----------------------------------------------------------------------------------

/**
 * How qualified a spelling of one thing the search term matched, or undefined
 * when it matched none of them. Spellings are given most specific first, and
 * the first one that matches wins.
 *
 * @param term - The search term.
 * @param spellings - Each spelling of this thing, with how qualified it is.
 */
function qualificationOf(
  term: string,
  spellings: [string, Qualification][]
): Qualification | undefined {
  for (const [spelling, qualification] of spellings) {
    if (spelling === term) return qualification;
  }
  return undefined;
}

/**
 * Every environment variable name that would be recognized as naming one
 * variable: the name its definition declares (a recipe may bind an existing
 * variable such as `GITHUB_TOKEN`), plus any generated name on the resolution
 * ladder that is actually in use in `.sous/.env` or `.sous/.env.local`.
 *
 * Generated names are only searched when they are in use, because every
 * variable generates four of them and a project would otherwise be told that a
 * name nothing has ever set names one of its variables.
 *
 * @param defined - The definition and the recipe that published it.
 * @param context - The environment layers, when the caller has them.
 */
function environmentNamesFor(
  defined: DefinedVariable,
  context: ReferenceContext
): Set<string> {
  const names = new Set<string>([bareName(defined.definition)]);

  const ladder = context.ladder;
  if (ladder === undefined) return names;

  const inUse = new Set([...Object.keys(ladder.localEnv), ...Object.keys(ladder.sharedEnv)]);
  for (const candidate of variableCandidates(defined, ladder)) {
    if (inUse.has(candidate.envName)) names.add(candidate.envName);
  }

  return names;
}

/**
 * Sorts matches into the documented listing order and drops anything the same
 * search found twice.
 *
 * @param matches - Every match, in the order they were collected.
 * @param repoOrder - Where each repository sits in the search order.
 */
function sortMatches(
  matches: ReferenceMatch[],
  repoOrder: Map<string, number>
): ReferenceMatch[] {
  const position = (repo: string | undefined): number =>
    repo === undefined ? 0 : (repoOrder.get(repo) ?? repoOrder.size);

  const sorted = [...matches].sort((left, right) => {
    if (left.qualification !== right.qualification) {
      return left.qualification - right.qualification;
    }
    const scopes = scopeRank(left.scope) - scopeRank(right.scope);
    if (scopes !== 0) return scopes;

    const repos = position(left.repo) - position(right.repo);
    if (repos !== 0) return repos;

    return compare(
      [left.namespace, left.recipe, left.variable],
      [right.namespace, right.recipe, right.variable]
    );
  });

  const seen = new Set<string>();
  return sorted.filter((match) => {
    const identity = `${match.scope} ${match.key} ${match.envName ?? ""}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/** Bytewise comparison of the parts of an identity, so listings are stable. */
function compare(
  left: (string | undefined)[],
  right: (string | undefined)[]
): number {
  for (let index = 0; index < left.length; index += 1) {
    const one = left[index] ?? "";
    const other = right[index] ?? "";
    if (one !== other) return one < other ? -1 : 1;
  }
  return 0;
}
