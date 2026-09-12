/**
 * What was searched when a ref matched nothing.
 *
 * Resolving a ref itself lives in `src/lib/refs/`, which every command shares.
 * All that is left here is the one thing only a repository search can say: which
 * repositories were actually looked in, and which were trusted but unreadable,
 * so the reader can tell "the name is wrong" from "the repository holding it
 * was never fetched".
 */

import type { IndexFile } from "./formats/index-file.js";

/** The repositories a ref was searched in, and the indexes that were available. */
export type IndexSearchInputs = {
  /** The name that was searched for. */
  name: string;
  /** The repositories the search covered, in search order. */
  repoOrder: string[];
  /** The cached index of each repository, keyed by short name. */
  indexes: Map<string, IndexFile>;
};

/**
 * The lines a name that matched nothing is explained with: every repository
 * whose index was searched, and every trusted repository whose index could not
 * be read.
 *
 * @param inputs - The same inputs the search was given.
 */
export function describeIndexSearch(inputs: IndexSearchInputs): string[] {
  const searched = inputs.repoOrder.filter((repo) => inputs.indexes.has(repo));
  const missing = inputs.repoOrder.filter((repo) => !inputs.indexes.has(repo));

  const lines = [
    searched.length === 0
      ? `  No repository index could be read, so there was nothing to search.`
      : `  Searched the namespaces and the recipe names of: ${searched.join(", ")}.`,
  ];
  if (missing.length > 0) {
    lines.push(
      `  These repositories are trusted but their index could not be read, so nothing ` +
        `in them was searched: ${missing.join(", ")}.`
    );
  }
  return lines;
}
