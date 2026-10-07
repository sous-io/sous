import type { RepoProvider } from "../../../lib/repos/providers/index.js";
import { makeInjectable } from "../injectable.js";
import { REF_TOKENS } from "../tokens.js";
import { providerById } from "../../../lib/repos/providers/index.js";
import { rangeOf } from "../parts.js";
import { RefSource, SOURCE_LABELS } from "../source.js";
import type { SousRef } from "../types.js";
import { RuleRefPruner, type RefPruneRule } from "./ref-pruner.js";
import { hasRepoName, isLocal, isStoredKind, KEBAB_REASON, shortKey } from "./rule-helpers.js";

/**
 * An entry of a recipe manifest's `depends` or `subscribes` list. A bare ref
 * names a namespace or a recipe in the same repository, and a location names
 * one in another. A manifest is published, so its names are stored lowercase.
 * It refuses a `repo:` qualifier (one project's private name for a repository),
 * a repository on this machine, a whole repository with nothing inside it, and
 * everything that is not a namespace or a recipe.
 */
export class ManifestPruner extends RuleRefPruner {
  readonly source = RefSource.Manifest;
  readonly place = SOURCE_LABELS[RefSource.Manifest];

  /**
   * @param providers - The providers that format a locator, for what to write instead.
   */
  constructor(private readonly providers: RepoProvider[]) {
    super();
  }

  protected rules(): RefPruneRule[] {
    return [
      {
        matches: hasRepoName,
        action: "drop",
        message:
          "a 'repo:' qualifier names a short name that only the consuming project knows, so it " +
          "cannot appear in a published manifest.",
        instead: (ref) =>
          `'${shortKey(ref).toLowerCase()}' for a recipe in this same repository, or name the ` +
          `other repository by its location, as in ` +
          `'github://owner/repository/${shortKey(ref).toLowerCase()}'`,
      },
      {
        matches: isLocal,
        action: "drop",
        message:
          "a local repository is a consumer's convenience, not a published location, so a " +
          "manifest cannot depend on one.",
        instead:
          "the recipe's published location, such as 'github://owner/repository/namespace/recipe'",
      },
      {
        matches: (ref) => ref.kind === "recipeFile",
        action: "drop",
        message:
          "a short ref has at most two path segments, a namespace and a recipe. A folder path " +
          "inside a repository is written as a URL copied from the browser instead.",
        instead: "'namespace/recipe', or the URL copied from the browser",
      },
      {
        matches: (ref) => ref.glob === true,
        action: "drop",
        message: KEBAB_REASON,
        instead: "'namespace/recipe'",
      },
      {
        matches: (ref) => ref.kind === "repo" && ref.browsed === undefined && ref.location !== undefined,
        action: "drop",
        message: (ref) =>
          `it names the repository at ${locationUrl(ref)} and nothing inside it, and a ` +
          "dependency is a namespace or a recipe.",
        instead: (ref) => `'${this.locator(ref)}'`,
      },
      {
        matches: (ref) => ref.kind === "recipe" && ref.namespace === undefined,
        action: "drop",
        message: (ref) =>
          rangeOf(ref) === undefined
            ? "a recipe is named with its namespace here, and a bare name is read as a " +
              "namespace."
            : "a version range applies to a recipe, and namespaces are not versioned. Name " +
              "the recipe with its namespace.",
        instead: "'namespace/recipe', optionally with a range such as '@^1.1'",
      },
      {
        matches: (ref) => !isStoredKind(ref) && !(ref.kind === "repo" && ref.browsed !== undefined),
        action: "drop",
        message: KEBAB_REASON,
        instead: "'namespace/recipe'",
      },
      {
        matches: (ref) => ref.vars !== undefined,
        action: "drop",
        message: "a manifest's dependency carries no query values.",
        instead: (ref) => `'${shortKey(ref).toLowerCase()}'`,
      },
    ];
  }

  protected normalize(ref: SousRef): SousRef {
    if (ref.kind === "namespace") return { ...ref, name: ref.name.toLowerCase() };
    if (ref.kind === "recipe") {
      return {
        ...ref,
        name: ref.name.toLowerCase(),
        ...(ref.namespace === undefined
          ? {}
          : { namespace: { ...ref.namespace, name: ref.namespace.name.toLowerCase() } }),
      };
    }
    return ref;
  }

  /** The canonical locator for something inside the ref's repository, as an example. */
  private locator(ref: SousRef): string {
    if (ref.kind !== "repo" || ref.location === undefined) return "github://owner/repository";
    const { host, repoPath } = ref.location;
    const provider = providerById(ref.location.provider, this.providers);
    return provider === undefined
      ? `${ref.location.url}/namespace/recipe`
      : provider.formatLocator(host, repoPath, "namespace/recipe");
  }
}

/** Where a located ref says its repository is. */
function locationUrl(ref: SousRef): string {
  return ref.kind === "repo" && ref.location !== undefined ? ref.location.url : "that location";
}

makeInjectable(ManifestPruner, [{ multi: REF_TOKENS.Provider }]);
