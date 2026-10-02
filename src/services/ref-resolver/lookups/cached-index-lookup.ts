import type { IndexFile } from "../../../lib/repos/formats/index-file.js";
import { locationFromUrl } from "../location.js";
import type { SousRef } from "../types.js";
import { CatalogMatcher, type CatalogRepo } from "./catalog-matcher.js";
import type { RefLookup, RefMatch } from "./ref-lookup.js";

/** What a `CachedIndexLookup` needs to know beyond the indexes themselves. */
export type CachedIndexLookupOptions = {
  /**
   * The repositories' short names, in the order their matches should be
   * listed: the built-in repository first, then the ones the config names.
   * Defaults to the order the indexes were added to the map.
   */
  order?: readonly string[];
  /**
   * Where each repository lives, by short name. It is how a ref written as a
   * location (a URL, a locator, a URL copied from the browser) finds the
   * repository whatever short name this project gave it.
   */
  urls?: Record<string, string | undefined>;
};

/**
 * Answers repositories, namespaces and recipes from the repository indexes
 * already on this machine. It reads nothing, fetches nothing and never fails:
 * a candidate no index publishes simply has no match.
 */
export class CachedIndexLookup implements RefLookup {
  private readonly matcher: CatalogMatcher;

  /**
   * @param indexes - Each repository's cached index, keyed by short name.
   * @param options - The listing order, and where each repository lives.
   */
  constructor(indexes: Map<string, IndexFile>, options: CachedIndexLookupOptions = {}) {
    const order = options.order ?? [...indexes.keys()];
    const repos: CatalogRepo[] = [];

    for (const name of order) {
      const index = indexes.get(name);
      if (index === undefined) continue;
      const url = options.urls?.[name];
      const location = url === undefined ? undefined : locationFromUrl(url);

      repos.push({
        name,
        ...(location === undefined ? {} : { location }),
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
      });
    }
    this.matcher = new CatalogMatcher(repos);
  }

  async find(candidate: SousRef): Promise<RefMatch[]> {
    return this.matcher.match(candidate);
  }
}
