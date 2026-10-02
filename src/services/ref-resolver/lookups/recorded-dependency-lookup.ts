import { locationOf } from "../parts.js";
import type { SousRef } from "../types.js";
import type { RefLookup, RefMatch } from "./ref-lookup.js";

/** What a repository's index recorded about one dependency, as far as settling needs. */
export type RecordedDependencies = Record<string, { repo?: string } | undefined>;

/**
 * Answers from what a published version's index entry recorded about its
 * dependencies, and never searches.
 *
 * A release settles a dependency that reads more than one way (a GitLab URL
 * with nested groups, a browser URL) and records the repository it settled on
 * beside each key it resolved; a consumer reads that record and never probes.
 * A candidate is confirmed when a record says so: a namespace by a record
 * under a key inside it, a recipe by a record under its own key, a browser
 * path by any record carrying its repository. A candidate that names no
 * location is confirmed by a record that names none, which is a sibling in the
 * declaring recipe's own repository.
 */
export class RecordedDependencyLookup implements RefLookup {
  /**
   * @param recorded - What the declaring version's index entry records, keyed `namespace/recipe`.
   */
  constructor(private readonly recorded: RecordedDependencies | undefined) {}

  async find(candidate: SousRef): Promise<RefMatch[]> {
    const identity = locationOf(candidate)?.identity;
    const records = Object.entries(this.recorded ?? {}).filter(([, record]) =>
      identity === undefined ? record?.repo === undefined : record?.repo === identity
    );

    const confirmed = (() => {
      switch (candidate.kind) {
        case "repo":
          return candidate.browsed !== undefined && identity !== undefined && records.length > 0;
        case "namespace":
          return records.some(([key]) => key.startsWith(`${candidate.name}/`));
        case "recipe":
          return (
            candidate.namespace !== undefined &&
            records.some(([key]) => key === `${candidate.namespace!.name}/${candidate.name}`)
          );
        default:
          return false;
      }
    })();

    return confirmed ? [{ ref: candidate, exactSpelling: true }] : [];
  }
}
