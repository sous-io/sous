/**
 * Settling a manifest dependency that reads more than one way, from what is
 * already at hand.
 *
 * A manifest entry usually says exactly what it means. A GitLab URL with nested
 * groups does not say where the project path ends, and a browser URL names a
 * folder, so the parser returns every reading. A release settles such an entry
 * and records the repository it settled on beside each key it resolved
 * (`RecordedDependencies`); a consumer reads that record and never probes.
 */

import { sharedRefResolver } from "./container.js";
import {
  isConfirmedByRecord,
  type RecordedDependencies,
} from "./lookups/recorded-dependency-lookup.js";
import { RefSource } from "./source.js";
import type { SousRef } from "./types.js";

/** What `settleDependency` may consult, beyond the dependency itself. */
export type SettleDependencyOptions = {
  /** What the declaring version's index entry records about its dependencies. */
  recorded?: RecordedDependencies;
  /**
   * Whether a reading is already known to be right from what is on this
   * machine: its repository is trusted and its cached index publishes what it
   * names. Used only when the index recorded nothing, and it never fetches.
   */
  known?: (reading: SousRef) => boolean;
};

/**
 * The one reading a manifest dependency settles on, or undefined when it reads
 * more than one way and nothing at hand says which: the declaring recipe's
 * index recorded no answer, and what this machine already knows does not pick
 * exactly one.
 *
 * settleDependency("workflow/alpha");
 * // -> the recipe workflow/alpha
 *
 * @param written - The dependency as the manifest wrote it.
 * @param options - The index's record, and what is known locally.
 * @throws A ConfigError when a manifest may not write the entry that way.
 */
export function settleDependency(
  written: string,
  options: SettleDependencyOptions = {}
): SousRef | undefined {
  const { refs } = sharedRefResolver().parse(written, RefSource.Manifest);
  if (refs.length === 1) return refs[0];

  const confirmed = refs.filter((ref) => isConfirmedByRecord(ref, options.recorded));
  if (confirmed.length === 1) return confirmed[0];

  if (options.known !== undefined) {
    const known = refs.filter(options.known);
    if (known.length === 1) return known[0];
  }
  return undefined;
}
