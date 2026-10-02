import type { RefLookup } from "./lookups/ref-lookup.js";
import { RefSource } from "./source.js";

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
   * @param init - The ref, where it was written (the command line by default), and what exists.
   */
  constructor(init: { input: string; from?: RefSource; lookup?: RefLookup }) {
    this.input = init.input;
    this.from = init.from ?? RefSource.CommandLine;
    if (init.lookup !== undefined) this.lookup = init.lookup;
  }
}
