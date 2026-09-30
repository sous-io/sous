/**
 * Settling what a ref means, once the index that can say is at hand.
 *
 * `parseRef` returns every reading of a written ref. Some readings are settled
 * the moment they are read (`workflow/alpha`), and some need the index of the
 * repository they point at: a browser URL names a folder, and only the `path`
 * each recipe's index entry records says which recipe that folder is; a GitLab
 * URL with nested groups can be read as several repositories, and only their
 * indexes say which one publishes what was named.
 *
 * Names are matched the same way everywhere: the exact spelling first, then
 * ignoring case. A name that still matches several things is a question for
 * `pickReference`.
 */

import {
  isBrowsedReading,
  isNamedReading,
  namespaceOfKey,
  parseRef,
  refKey,
  splitRecipeKey,
  type ParsedRef,
  type RefReading,
} from "./parse.js";
import { RefSource } from "./scopes.js";

/**
 * The names that match a written one: those spelled exactly as written, or,
 * when there is none, those that differ only in case.
 *
 * matchNames("Workflow", ["workflow", "tooling"]); // -> ["workflow"]
 * matchNames("workflow", ["workflow", "Workflow"]); // -> ["workflow"]
 *
 * @param written - The name as written.
 * @param names - The names it could mean.
 */
export function matchNames(written: string, names: Iterable<string>): string[] {
  const all = [...names];
  const exact = all.filter((name) => name === written);
  if (exact.length > 0) return exact;
  const folded = written.toLowerCase();
  return all.filter((name) => name.toLowerCase() === folded);
}

/** What settling needs to know about one repository's index. */
export type SettleIndex = {
  /** Every namespace the index publishes. */
  namespaces: Iterable<string>;
  /** Every recipe it publishes, keyed `namespace/recipe`, with the folder it lives in. */
  recipes: Record<string, { path: string }>;
};

/**
 * What a reading names in one repository's index, spelled the way the index
 * spells it. A named reading that the index does not publish settles to
 * nothing; a browsed path settles through the recipe paths.
 *
 * settleInIndex({ namespace: "Workflow", recipe: "alpha" }, index);
 * // -> [{ namespace: "workflow", recipe: "alpha" }]
 *
 * @param reading - One reading of a written ref.
 * @param index - The index of the repository the reading points at.
 */
export function settleInIndex(reading: RefReading, index: SettleIndex): ParsedRef[] {
  const carried = {
    ...(reading.location === undefined ? {} : { location: reading.location }),
    ...("range" in reading && reading.range !== undefined ? { range: reading.range } : {}),
    ...("repo" in reading && reading.repo !== undefined ? { repo: reading.repo } : {}),
  };

  if (isBrowsedReading(reading)) {
    return settleBrowsed(reading.browsed, index).map((settled) => ({ ...settled, ...carried }));
  }
  if (!isNamedReading(reading)) return [];

  if (reading.recipe === undefined) {
    return matchNames(reading.namespace, index.namespaces).map((namespace) => ({
      namespace,
      ...carried,
    }));
  }

  return matchNames(refKey(reading), Object.keys(index.recipes)).map((key) => {
    const { namespace, name } = splitRecipeKey(key);
    return { namespace, recipe: name, ...carried };
  });
}

/**
 * What a browser path names, through the folder each recipe's index entry
 * records. The path still carries the branch in front (which may itself hold
 * slashes), so every split is tried: the folder of a recipe, or anything inside
 * it, names that recipe; a folder holding recipes of exactly one namespace
 * names that namespace.
 *
 * settleBrowsed("main/recipes/workflow/alpha/SKILL.md", index);
 * // -> [{ namespace: "workflow", recipe: "alpha" }]
 *
 * @param browsed - The path after `tree/` or `blob/`, branch included.
 * @param index - The repository's index.
 */
export function settleBrowsed(browsed: string, index: SettleIndex): ParsedRef[] {
  const segments = browsed.split("/").filter((segment) => segment.length > 0);
  const recipes = Object.entries(index.recipes).map(([key, entry]) => ({
    key,
    path: entry.path.replace(/^\.?\/+|\/+$/g, ""),
  }));

  const found = new Map<string, ParsedRef>();

  // A recipe's folder, or a file inside it. The deepest recipe wins, so a
  // recipe nested inside another's folder is named by its own path.
  for (let start = 1; start < segments.length; start++) {
    const folder = segments.slice(start).join("/");
    const holding = recipes
      .filter((recipe) => folder === recipe.path || folder.startsWith(`${recipe.path}/`))
      .sort((left, right) => right.path.length - left.path.length);
    const deepest = holding[0];
    if (deepest !== undefined) {
      const { namespace, name } = splitRecipeKey(deepest.key);
      found.set(deepest.key, { namespace, recipe: name });
    }
  }
  if (found.size > 0) return [...found.values()];

  // A folder above recipes: a namespace, when everything under it is one.
  for (let start = 1; start < segments.length; start++) {
    const folder = segments.slice(start).join("/");
    const under = recipes.filter((recipe) => recipe.path.startsWith(`${folder}/`));
    const namespaces = new Set(under.map((recipe) => namespaceOfKey(recipe.key)));
    if (namespaces.size === 1) {
      const namespace = [...namespaces][0]!;
      found.set(namespace, { namespace });
    }
  }
  return [...found.values()];
}

/** What a repository's index recorded about one dependency, as far as settling needs. */
export type RecordedDependencies = Record<string, { repo?: string } | undefined>;

/**
 * The readings of a manifest dependency that the declaring recipe's index
 * confirms. A release settles a dependency that reads more than one way (a
 * GitLab URL with nested groups, a browser URL) and records the repository it
 * settled on beside each key it resolved; a consumer reads that record and never
 * probes. A dependency that reads one way needs no record and comes back as it
 * is.
 *
 * A named reading is confirmed by a record under its own key (or, for a whole
 * namespace, under a key inside it) carrying its repository; a browsed reading
 * by any record carrying its repository.
 *
 * @param readings - Every reading of the dependency, from `parseRef`.
 * @param recorded - What the declaring version's index entry records, keyed `namespace/recipe`.
 * @returns The confirmed readings: one is the answer; none or several leave it unsettled.
 */
export function confirmedReadings(
  readings: RefReading[],
  recorded: RecordedDependencies | undefined
): RefReading[] {
  if (readings.length === 1) return readings;
  const records = Object.entries(recorded ?? {});

  return readings.filter((reading) => {
    const identity = reading.location?.identity;
    if (identity === undefined) return false;
    return records.some(([key, record]) => {
      if (record?.repo !== identity) return false;
      if (isBrowsedReading(reading)) return true;
      if (!isNamedReading(reading)) return false;
      return reading.recipe === undefined
        ? key.startsWith(`${reading.namespace}/`)
        : key === refKey(reading);
    });
  });
}

/** What `settleDependency` may consult, beyond the dependency itself. */
export type SettleDependencyOptions = {
  /** What the declaring version's index entry records about its dependencies. */
  recorded?: RecordedDependencies;
  /**
   * Whether a reading is already known to be right from what is on this
   * machine: its repository is trusted and its cached index publishes what it
   * names. Used only when the index recorded nothing, and it never fetches.
   */
  known?: (reading: RefReading) => boolean;
};

/**
 * The one reading a manifest dependency settles on, or undefined when it reads
 * more than one way and nothing at hand says which: the declaring recipe's
 * index recorded no answer, and what this machine already knows does not pick
 * exactly one.
 *
 * settleDependency("workflow/alpha");
 * // -> { namespace: "workflow", recipe: "alpha" }
 *
 * @param written - The dependency as the manifest wrote it.
 * @param options - The index's record, and what is known locally.
 */
export function settleDependency(
  written: string,
  options: SettleDependencyOptions = {}
): RefReading | undefined {
  const readings = parseRef(written, RefSource.Manifest);
  if (readings.length === 1) return readings[0];

  const confirmed = confirmedReadings(readings, options.recorded);
  if (confirmed.length === 1) return confirmed[0];

  if (options.known !== undefined) {
    const known = readings.filter(options.known);
    if (known.length === 1) return known[0];
  }
  return undefined;
}
