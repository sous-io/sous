/**
 * Lookups: what exists, as a queryable object rather than a list.
 *
 * A caller that knows what exists (the cached indexes, a release's recorded
 * dependencies, the variable definitions in play) hands the resolver a lookup,
 * and the candidate readings narrow to the ones that are actually available.
 */

import type { SousRef } from "../types.js";

/** One thing a candidate reading turned out to name. */
export type RefMatch = {
  /**
   * The known ref, spelled the way it is published (not the way it was
   * typed), with every parent it has.
   */
  ref: SousRef;
  /**
   * True when every part of the candidate matched in exactly the case it was
   * written. A lookup returns case-insensitive matches too; the resolver keeps
   * them only when nothing matched exactly.
   */
  exactSpelling: boolean;
};

/**
 * Answers what a candidate reading names.
 *
 * `find` returns an empty array when nothing known matches the candidate, and
 * throws when the lookup could not find out (an index that could not be
 * fetched): not finding an answer and failing to look are different things.
 */
export interface RefLookup {
  /**
   * Every known ref a candidate names.
   *
   * @param candidate - One reading of a written ref.
   */
  find(candidate: SousRef): Promise<RefMatch[]>;
}
