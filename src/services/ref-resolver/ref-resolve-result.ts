import type { DroppedRef } from "./pruners/ref-pruner.js";
import type { SousRef } from "./types.js";

/** What `RefResolverService.resolve` found. */
export class RefResolveResult {
  /**
   * @param input - The ref exactly as it was written.
   * @param refs - The refs it names, best first: the more qualified the spelling that
   *   matched, the earlier. Empty when a lookup knew none of the readings.
   * @param dropped - The readings the place refused, with the reason for each.
   * @param warnings - Sentences about readings that were kept all the same.
   * @param usedLookup - True when `refs` were narrowed against what exists.
   */
  constructor(
    readonly input: string,
    readonly refs: SousRef[],
    readonly dropped: DroppedRef[],
    readonly warnings: string[],
    readonly usedLookup: boolean
  ) {}

  /** True when exactly one ref is left, so the caller has nothing to decide. */
  get isUnique(): boolean {
    return this.refs.length === 1;
  }

  /** True when no ref is left. */
  get isEmpty(): boolean {
    return this.refs.length === 0;
  }

  /** The best ref, or undefined when none is left. */
  first(): SousRef | undefined {
    return this.refs[0];
  }
}
