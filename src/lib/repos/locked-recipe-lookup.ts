/**
 * What an include line may name: the recipes the lockfile pins.
 *
 * A `RefLookup` over the pinned recipes, answering a `recipeFile` reading (the
 * namespace and recipe names, and the path inside the recipe) with every pinned
 * recipe whose names match it. Names are compared as the ref service compares
 * every name: exact spelling first, ignoring case as the fallback, and a name
 * may be a glob (`*`, `**`, `?`, `[..]`, `{a,b}`). The path inside the recipe
 * is carried through as written; expanding it into files is the include
 * resolver's job, because only it knows which directory each recipe lives in.
 */

import {
  compareBytewise,
  matchName,
  repoOf,
  type NameMatch,
  type RefMatch,
  type SousRef,
  type SyncRefLookup,
} from "../../services/ref-resolver/index.js";

/** One pinned recipe, as far as a lookup needs to know it. */
export type RecipeFileEntry = {
  /** The recipe's namespace. */
  namespace: string;
  /** The recipe's name. */
  name: string;
  /** The short name of the repository it came from, when known. */
  repo?: string;
};

/** The weakest of two matches: a name that matched only ignoring case spoils an exact one. */
function combine(left: NameMatch, right: NameMatch): NameMatch {
  if (left === undefined || right === undefined) return undefined;
  return left === "exact" && right === "exact" ? "exact" : "folded";
}

/** Answers which pinned recipes an include reading names. */
export class LockedRecipeFileLookup implements SyncRefLookup {
  /**
   * @param entries - Every recipe the lockfile pins.
   */
  constructor(private readonly entries: readonly RecipeFileEntry[]) {}

  /** The distinct namespaces of the pinned recipes, sorted. */
  namespaces(): string[] {
    return [...new Set(this.entries.map((entry) => entry.namespace))].sort(compareBytewise);
  }

  /**
   * The pinned recipes of the namespaces a written namespace matches, sorted
   * by key: those whose spelling matches exactly, or, when none does, those
   * that differ only in case.
   *
   * @param written - The namespace as written, possibly a glob.
   */
  recipesInNamespace(written: string): string[] {
    const matched = this.entries
      .map((entry) => ({ entry, match: matchName(written, entry.namespace) }))
      .filter((hit) => hit.match !== undefined);
    const exact = matched.filter((hit) => hit.match === "exact");
    return (exact.length > 0 ? exact : matched)
      .map((hit) => `${hit.entry.namespace}/${hit.entry.name}`)
      .sort(compareBytewise);
  }

  /**
   * True when a written namespace matches a pinned one in some spelling.
   *
   * @param written - The namespace as written, possibly a glob.
   */
  knowsNamespace(written: string): boolean {
    return this.entries.some((entry) => matchName(written, entry.namespace) !== undefined);
  }

  findSync(candidate: SousRef): RefMatch[] {
    if (candidate.kind !== "recipeFile") return [];
    const written = candidate.recipe;
    const namespaceName = written.namespace?.name;
    if (namespaceName === undefined) return [];
    const repoName = repoOf(candidate)?.name;

    const found: RefMatch[] = [];
    for (const entry of this.entries) {
      let match = combine(
        matchName(namespaceName, entry.namespace),
        matchName(written.name, entry.name)
      );
      if (repoName !== undefined) {
        match = combine(
          match,
          entry.repo === undefined ? undefined : matchName(repoName, entry.repo)
        );
      }
      if (match === undefined) continue;
      found.push({
        ref: {
          kind: "recipeFile",
          path: candidate.path,
          recipe: {
            kind: "recipe",
            name: entry.name,
            namespace: { kind: "namespace", name: entry.namespace },
          },
          ...(candidate.glob === undefined ? {} : { glob: true as const }),
          ...(candidate.vars === undefined ? {} : { vars: candidate.vars }),
        },
        exactSpelling: match === "exact",
      });
    }
    return found.sort((left, right) => compareBytewise(keyOf(left.ref), keyOf(right.ref)));
  }

  async find(candidate: SousRef): Promise<RefMatch[]> {
    return this.findSync(candidate);
  }
}

/** The `namespace/recipe` key of a recipe file ref, for ordering. */
function keyOf(ref: SousRef): string {
  return ref.kind === "recipeFile" ? `${ref.recipe.namespace?.name}/${ref.recipe.name}` : "";
}
