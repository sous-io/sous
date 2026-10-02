import type { RefLookup } from "./lookups/ref-lookup.js";
import { RefSource } from "./source.js";
import type { RefKind } from "./types.js";

/** What `RefResolverService.resolve` is asked. */
export class RefResolveArguments {
  /** The ref exactly as it was written. */
  readonly input: string;
  /** Where it was written, which decides the forms allowed. */
  readonly from: RefSource;
  /**
   * What exists. When given, the readings narrow to the ones it knows, spelled
   * the way they are published; when absent, the readings the place allows are
   * returned as they were read.
   */
  readonly lookup?: RefLookup;
  /**
   * The kinds of ref the caller accepts. Readings of any other kind are set
   * aside before the lookup is asked, so a word that is a repository exactly
   * and a namespace only ignoring case is still found as the namespace by a
   * caller that accepts namespaces alone.
   */
  readonly kinds?: readonly RefKind[];
  /**
   * True when a ref the place refuses in every reading (an empty word, a path
   * of three segments) names nothing instead of raising the refusal. A command
   * that takes any word and answers "nothing called that was found" uses it.
   */
  readonly refusedIsEmpty: boolean;

  /**
   * @param init - The ref, where it was written (the command line by default), what exists, the kinds accepted, and whether a refused ref names nothing.
   */
  constructor(init: {
    input: string;
    from?: RefSource;
    lookup?: RefLookup;
    kinds?: readonly RefKind[];
    refusedIsEmpty?: boolean;
  }) {
    this.input = init.input;
    this.from = init.from ?? RefSource.CommandLine;
    if (init.lookup !== undefined) this.lookup = init.lookup;
    if (init.kinds !== undefined) this.kinds = init.kinds;
    this.refusedIsEmpty = init.refusedIsEmpty ?? false;
  }
}
