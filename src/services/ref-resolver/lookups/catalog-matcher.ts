/**
 * Matching repositories, namespaces and recipes against a catalog of what is
 * published. Every lookup that knows repositories (cached indexes, fetched
 * indexes, the definitions in play) builds a catalog and asks this.
 *
 * Names are matched the same way everywhere: the exact spelling first, then
 * ignoring case, and a name may be a glob pattern. A match is returned in the
 * spelling the catalog publishes.
 */

import type { IndexFile } from "../../../lib/repos/formats/index-file.js";
import { matchName, type NameMatch } from "../glob.js";
import { refKey } from "../format.js";
import type { NamespaceRef, RecipeRef, RefLocation, RepoRef, SousRef } from "../types.js";
import type { RefMatch } from "./ref-lookup.js";

/** One repository, and what it publishes. */
export type CatalogRepo = {
  /** The short name this project calls it, when it has one. */
  name?: string;
  /** Where it lives, which is how a ref written as a location finds it. */
  location?: RefLocation;
  /** Every namespace it publishes. */
  namespaces: Array<{ name: string; description?: string }>;
  /** Every recipe it publishes. */
  recipes: Array<{ namespace: string; name: string; description?: string; path?: string }>;
};

/**
 * The catalog entry for one repository's index.
 *
 * @param index - The repository's index.
 * @param repo - What the project knows of the repository: its short name and where it lives.
 */
export function catalogRepoOfIndex(
  index: IndexFile,
  repo: { name?: string; location?: RefLocation } = {}
): CatalogRepo {
  return {
    ...(repo.name === undefined ? {} : { name: repo.name }),
    ...(repo.location === undefined ? {} : { location: repo.location }),
    namespaces: Object.entries(index.namespaces).map(([namespace, declared]) => ({
      name: namespace,
      ...(declared?.description === undefined ? {} : { description: declared.description }),
    })),
    recipes: Object.entries(index.recipes).map(([key, recipe]) => {
      const slash = key.indexOf("/");
      return {
        namespace: key.slice(0, slash),
        name: key.slice(slash + 1),
        path: recipe.path,
        ...(recipe.description === undefined ? {} : { description: recipe.description }),
      };
    }),
  };
}

/** The weaker of two matches: one folded part makes the whole thing folded. */
function both(left: NameMatch, right: NameMatch): NameMatch {
  if (left === undefined || right === undefined) return undefined;
  return left === "folded" || right === "folded" ? "folded" : "exact";
}

/** Matches refs against a catalog, repository by repository, in catalog order. */
export class CatalogMatcher {
  /**
   * @param repos - The repositories to search, in the order their matches are listed.
   */
  constructor(private readonly repos: CatalogRepo[]) {}

  /**
   * Every repository, namespace or recipe in the catalog a candidate names.
   * Candidates of any other kind match nothing.
   *
   * @param candidate - One reading of a written ref.
   */
  match(candidate: SousRef): RefMatch[] {
    const found: Array<RefMatch & { repoIndex: number }> = [];

    this.repos.forEach((repo, repoIndex) => {
      const add = (ref: SousRef, spelling: NameMatch): void => {
        if (spelling === undefined) return;
        found.push({ ref, exactSpelling: spelling === "exact", repoIndex });
      };

      switch (candidate.kind) {
        case "repo": {
          if (candidate.browsed !== undefined) {
            for (const settled of this.settleBrowsed(candidate, repo)) add(settled, "exact");
          } else {
            add(...this.matchRepo(candidate, repo));
          }
          break;
        }
        case "namespace": {
          const qualifier = this.qualifies(candidate.repo, repo);
          for (const namespace of repo.namespaces) {
            const spelling = both(qualifier, matchName(candidate.name, namespace.name));
            if (spelling === undefined) continue;
            add(
              this.carry(candidate, {
                kind: "namespace",
                name: namespace.name,
                repo: this.knownRepo(repo),
                ...(namespace.description === undefined ? {} : { description: namespace.description }),
              }),
              spelling
            );
          }
          break;
        }
        case "recipe": {
          const qualifier = this.qualifies(candidate.namespace?.repo ?? candidate.repo, repo);
          for (const recipe of repo.recipes) {
            const inNamespace =
              candidate.namespace === undefined
                ? "exact"
                : matchName(candidate.namespace.name, recipe.namespace);
            const spelling = both(
              both(qualifier, inNamespace),
              matchName(candidate.name, recipe.name)
            );
            if (spelling === undefined) continue;
            add(this.carry(candidate, this.knownRecipe(repo, recipe)), spelling);
          }
          break;
        }
        default:
          break;
      }
    });

    return found
      .sort((left, right) =>
        left.repoIndex !== right.repoIndex
          ? left.repoIndex - right.repoIndex
          : refKey(left.ref) < refKey(right.ref)
            ? -1
            : refKey(left.ref) > refKey(right.ref)
              ? 1
              : 0
      )
      .map(({ ref, exactSpelling }) => ({ ref, exactSpelling }));
  }

  /** How a repository qualifier matches one catalog repository (no qualifier matches all). */
  private qualifies(qualifier: RepoRef | undefined, repo: CatalogRepo): NameMatch {
    if (qualifier === undefined) return "exact";
    let result: NameMatch = "exact";
    if (qualifier.name !== undefined) {
      if (repo.name === undefined) return undefined;
      result = matchName(qualifier.name, repo.name);
      if (result === undefined) return undefined;
    }
    if (qualifier.location !== undefined) {
      if (repo.location?.identity !== qualifier.location.identity) return undefined;
    }
    return result;
  }

  /** The repository ref a catalog repository is known as. */
  private knownRepo(repo: CatalogRepo, revision?: string): RepoRef {
    return {
      kind: "repo",
      ...(repo.name === undefined ? {} : { name: repo.name }),
      ...(repo.location === undefined ? {} : { location: repo.location }),
      ...(revision === undefined ? {} : { revision }),
    };
  }

  /** The recipe ref a catalog recipe is known as, parents and all. */
  private knownRecipe(repo: CatalogRepo, recipe: CatalogRepo["recipes"][number], revision?: string): RecipeRef {
    const namespace: NamespaceRef = {
      kind: "namespace",
      name: recipe.namespace,
      repo: this.knownRepo(repo, revision),
    };
    return {
      kind: "recipe",
      name: recipe.name,
      namespace,
      ...(recipe.description === undefined ? {} : { description: recipe.description }),
    };
  }

  /** What a candidate carries over to the known ref it matched: its range and query values. */
  private carry(candidate: SousRef, known: SousRef): SousRef {
    return {
      ...known,
      ...(candidate.kind === "recipe" && candidate.range !== undefined
        ? { range: candidate.range }
        : {}),
      ...(candidate.vars === undefined ? {} : { vars: candidate.vars }),
    } as SousRef;
  }

  /** A repository ref, named by short name or by location. */
  private matchRepo(candidate: RepoRef, repo: CatalogRepo): [SousRef, NameMatch] {
    const known = this.knownRepo(repo);
    if (candidate.name === undefined && candidate.location === undefined) return [known, undefined];
    return [
      { ...known, ...(candidate.vars === undefined ? {} : { vars: candidate.vars }) },
      this.qualifies(candidate, repo),
    ];
  }

  /**
   * What a browser path names in one repository, through the folder each
   * recipe lives in. The path still carries the branch in front of it (which
   * may itself hold slashes), so every split is tried: the folder of a recipe,
   * or anything inside it, names that recipe; a folder holding recipes of
   * exactly one namespace names that namespace.
   *
   * settleBrowsed("main/recipes/workflow/alpha/SKILL.md")
   * // -> the recipe workflow/alpha, with the revision "main"
   */
  private settleBrowsed(candidate: RepoRef, repo: CatalogRepo): SousRef[] {
    if (candidate.location === undefined || repo.location?.identity !== candidate.location.identity) {
      return [];
    }
    const segments = (candidate.browsed ?? "").split("/").filter((segment) => segment.length > 0);
    const recipes = repo.recipes
      .map((recipe) => ({ recipe, path: (recipe.path ?? "").replace(/^\.?\/+|\/+$/g, "") }))
      .filter((entry) => entry.path.length > 0);

    const range = candidate.range === undefined ? {} : { range: candidate.range };
    const found = new Map<string, SousRef>();

    // A recipe's folder, or a file inside it. The deepest recipe wins, so a
    // recipe nested inside another's folder is named by its own path.
    for (let start = 1; start < segments.length; start++) {
      const folder = segments.slice(start).join("/");
      const holding = recipes
        .filter((entry) => folder === entry.path || folder.startsWith(`${entry.path}/`))
        .sort((left, right) => right.path.length - left.path.length);
      const deepest = holding[0];
      if (deepest === undefined) continue;
      const revision = segments.slice(0, start).join("/");
      found.set(`${deepest.recipe.namespace}/${deepest.recipe.name}`, {
        ...this.knownRecipe(repo, deepest.recipe, revision),
        ...range,
      });
    }
    if (found.size > 0) return [...found.values()];

    // A folder above recipes: a namespace, when everything under it is one.
    for (let start = 1; start < segments.length; start++) {
      const folder = segments.slice(start).join("/");
      const under = recipes.filter((entry) => entry.path.startsWith(`${folder}/`));
      const namespaces = new Set(under.map((entry) => entry.recipe.namespace));
      if (namespaces.size !== 1) continue;
      const name = [...namespaces][0]!;
      found.set(name, {
        kind: "namespace",
        name,
        repo: this.knownRepo(repo, segments.slice(0, start).join("/")),
      });
    }
    return [...found.values()];
  }
}
