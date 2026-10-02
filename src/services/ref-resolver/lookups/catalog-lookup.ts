import type { SousRef } from "../types.js";
import { CatalogMatcher, type CatalogRepo } from "./catalog-matcher.js";
import type { RefLookup, RefMatch } from "./ref-lookup.js";

/**
 * Answers repositories, namespaces and recipes from a catalog a caller has
 * already built (which repositories it knows, and what each publishes). It
 * reads nothing, fetches nothing and never fails.
 */
export class CatalogLookup implements RefLookup {
  private readonly matcher: CatalogMatcher;

  /**
   * @param repos - The repositories to search, in the order their matches are listed.
   */
  constructor(repos: CatalogRepo[]) {
    this.matcher = new CatalogMatcher(repos);
  }

  async find(candidate: SousRef): Promise<RefMatch[]> {
    return this.matcher.match(candidate);
  }
}
