import type { SousRef } from "../types.js";
import type { RefLookup, RefMatch } from "./ref-lookup.js";

/**
 * Asks several lookups in order. The first one that answers a candidate with a
 * non-empty list wins and the rest are never asked, so a cheap, authoritative
 * source (a release's record) can sit in front of a broad one (every cached
 * index). A lookup that throws stops the chain: a failure is never skipped.
 */
export class ChainedLookup implements RefLookup {
  private readonly lookups: RefLookup[];

  /**
   * @param lookups - The lookups to ask, most authoritative first.
   */
  constructor(...lookups: RefLookup[]) {
    this.lookups = lookups;
  }

  async find(candidate: SousRef): Promise<RefMatch[]> {
    for (const lookup of this.lookups) {
      const matches = await lookup.find(candidate);
      if (matches.length > 0) return matches;
    }
    return [];
  }
}
