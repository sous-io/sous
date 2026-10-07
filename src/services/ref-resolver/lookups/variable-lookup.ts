import type { DefinedVariable } from "../../../lib/vars/definition-source.js";
import { matchName, type NameMatch } from "../glob.js";
import { refKey } from "../format.js";
import type { RepoRef, SousRef, VariableRef } from "../types.js";
import { CatalogMatcher, type CatalogRepo } from "./catalog-matcher.js";
import type { RefLookup, RefMatch } from "./ref-lookup.js";

/**
 * The ref a defined variable is known as: its name, with the recipe that
 * published it, that recipe's namespace and the repository's short name nested
 * as parents.
 *
 * @param defined - The definition and the recipe that published it.
 */
export function variableRefOf(defined: DefinedVariable): VariableRef {
  const { repo, namespace, name } = defined.recipe;
  return {
    kind: "variable",
    name: defined.definition.name,
    description: defined.definition.prompt,
    recipe: {
      kind: "recipe",
      name,
      namespace: { kind: "namespace", name: namespace, repo: { kind: "repo", name: repo } },
    },
  };
}

/** The weaker of two matches: one folded part makes the whole thing folded. */
function both(left: NameMatch, right: NameMatch): NameMatch {
  if (left === undefined || right === undefined) return undefined;
  return left === "folded" || right === "folded" ? "folded" : "exact";
}

/**
 * Answers from the variable definitions in play, which is what a variables
 * command searches: variables themselves (by name, or qualified by recipe,
 * namespace and repository, in any combination) and the repositories,
 * namespaces and recipes that publish them. A namespace that publishes no
 * variable this project holds has no questions to ask, so naming it would
 * resolve to nothing rather than to an empty set of questions. Building the
 * answer from the definitions also means `sous vars ask --file` resolves refs
 * exactly as a subscribed project does.
 */
export class VariableLookup implements RefLookup {
  private readonly matcher: CatalogMatcher;

  /**
   * @param variables - The variable definitions in play, with the recipe that published each.
   * @param trusted - The trusted repositories, which lend each repository its location
   *   and each recipe its folder, so a ref written as a location settles here too.
   */
  constructor(
    private readonly variables: DefinedVariable[],
    private readonly trusted: CatalogRepo[] = []
  ) {
    const repos = new Map<string, CatalogRepo>();

    for (const defined of variables) {
      const { repo: repoName, namespace, name: recipe } = defined.recipe;
      const known = trusted.find((entry) => entry.name === repoName);

      let repo = repos.get(repoName);
      if (repo === undefined) {
        repo = {
          name: repoName,
          namespaces: [],
          recipes: [],
          ...(known?.location === undefined ? {} : { location: known.location }),
        };
        repos.set(repoName, repo);
      }
      if (!repo.namespaces.some((entry) => entry.name === namespace)) {
        repo.namespaces.push({ name: namespace });
      }
      if (!repo.recipes.some((entry) => entry.namespace === namespace && entry.name === recipe)) {
        const path = known?.recipes.find(
          (entry) => entry.namespace === namespace && entry.name === recipe
        )?.path;
        repo.recipes.push({ namespace, name: recipe, ...(path === undefined ? {} : { path }) });
      }
    }
    this.matcher = new CatalogMatcher([...repos.values()]);
  }

  async find(candidate: SousRef): Promise<RefMatch[]> {
    if (candidate.kind !== "variable") return this.matcher.match(candidate);

    const qualifier: RepoRef | undefined =
      candidate.recipe?.namespace?.repo ?? candidate.recipe?.repo ?? candidate.repo;
    const matches: RefMatch[] = [];

    for (const defined of this.variables) {
      const { repo, namespace, name: recipe } = defined.recipe;
      const location = this.trusted.find((entry) => entry.name === repo)?.location;

      let spelling: NameMatch = "exact";
      if (qualifier?.name !== undefined) spelling = matchName(qualifier.name, repo);
      if (qualifier?.location !== undefined && location?.identity !== qualifier.location.identity) {
        spelling = undefined;
      }
      if (candidate.recipe !== undefined) {
        spelling = both(spelling, matchName(candidate.recipe.name, recipe));
        if (candidate.recipe.namespace !== undefined) {
          spelling = both(spelling, matchName(candidate.recipe.namespace.name, namespace));
        }
      }
      spelling = both(spelling, matchName(candidate.name, defined.definition.name));
      if (spelling === undefined) continue;

      matches.push({
        ref: {
          ...variableRefOf(defined),
          ...(candidate.vars === undefined ? {} : { vars: candidate.vars }),
        },
        exactSpelling: spelling === "exact",
      });
    }
    return matches.sort((left, right) =>
      refKey(left.ref) < refKey(right.ref) ? -1 : refKey(left.ref) > refKey(right.ref) ? 1 : 0
    );
  }
}
