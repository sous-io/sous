/**
 * Settling, at release time, the dependencies that read more than one way.
 *
 * Most dependencies say exactly what they mean: `workflow/alpha`, or
 * `github://owner/repo/workflow/alpha`. Two kinds do not:
 *
 *   - a GitLab URL with nested groups, which does not say where the project path
 *     ends (`gitlab.com/a/b/c/d` may be project `a/b` with namespace `c` and
 *     recipe `d`, or project `a/b/c` with namespace `d`);
 *   - a browser URL copied from a host's file view, which names a folder whose
 *     recipe only that repository's index can say.
 *
 * `sous repo release` settles each of them once, by fetching the index of every
 * candidate repository through the provider layer and keeping the reading whose
 * index publishes what was named. What it settled on is recorded in the index
 * beside the dependency's key, so a consumer reads the answer and never probes.
 *
 * A network failure fails the release: a release never falls through to the
 * next reading, because the reading it fell through to could be the wrong one.
 * Two readings that both publish what is named are a genuine tie, and an error
 * naming the spellings that read one way (the `/*` form for the namespace).
 */

import type { ProviderOptions, RepoProvider } from "../providers/index.js";
import {
  FetchedIndexLookup,
  RefSource,
  locationOf,
  namespaceOf,
  rangeOf,
  sharedRefResolver,
  shortKey,
  type SousRef,
} from "../../../services/ref-resolver/index.js";
import { describeError, type RepoValidation, type ValidationProblem } from "./validate.js";

/** What one dependency settled on. */
export type SettledDependency = {
  /** The canonical identity of the repository publishing it. */
  identity: string;
  /**
   * The recipe keys it reaches in that repository: one for a recipe, and every
   * recipe the namespace publishes for a namespace.
   */
  keys: string[];
  /** The range the manifest wrote, when it wrote one. */
  range?: string;
};

/** What settling found. */
export type SettleResult = {
  /** Each settled dependency, keyed by the dependency exactly as written (trimmed). */
  settled: Map<string, SettledDependency>;
  /** Everything that could not be settled; every one of them is an error. */
  problems: ValidationProblem[];
};

/** How settling reaches the network. */
export type SettleOptions = {
  /** The providers to fetch through. Defaults to the built-ins. */
  providers?: RepoProvider[];
  /** Testing seams handed to every index fetch. */
  providerOptions?: ProviderOptions;
};

/**
 * True when a dependency's readings need an index to settle: it reads more than
 * one way, or it names a browser path.
 *
 * @param readings - Every reading of the dependency.
 */
export function needsSettling(readings: SousRef[]): boolean {
  return (
    readings.length > 1 ||
    readings.some((reading) => reading.kind === "repo" && reading.browsed !== undefined)
  );
}

/**
 * Settles every dependency in a repository that reads more than one way.
 * Dependencies that read one way are left alone, and nothing is fetched for
 * them, so a repository that uses none of these forms releases offline as
 * before.
 *
 * @param validation - The validated repository.
 * @param options - The providers, and testing seams.
 */
export async function settleDependencyLocations(
  validation: RepoValidation,
  options: SettleOptions = {}
): Promise<SettleResult> {
  const settled = new Map<string, SettledDependency>();
  const problems: ValidationProblem[] = [];
  const lookup = new FetchedIndexLookup({
    subject: "dependency",
    ...(options.providers === undefined ? {} : { providers: options.providers }),
    ...(options.providerOptions === undefined ? {} : { providerOptions: options.providerOptions }),
  });

  for (const recipe of validation.recipes) {
    const declared = [...(recipe.manifest.depends ?? []), ...(recipe.manifest.subscribes ?? [])];
    for (const written of declared) {
      const trimmed = written.trim();
      if (settled.has(trimmed)) continue;

      let readings: SousRef[];
      try {
        readings = sharedRefResolver().parse(trimmed, RefSource.Manifest).refs;
      } catch {
        // Validation already reported a dependency that does not parse.
        continue;
      }
      if (!needsSettling(readings)) continue;

      const where = `${recipe.path} ('${trimmed}')`;
      try {
        settled.set(trimmed, await settleOne(readings, lookup));
      } catch (error) {
        problems.push({ level: "error", where, message: describeError(error) });
      }
    }
  }

  return { settled, problems };
}

/**
 * Settles one dependency: the one reading whose repository's index publishes
 * what it names.
 *
 * @param readings - Every reading of the dependency.
 * @param lookup - The fetched indexes.
 */
async function settleOne(
  readings: SousRef[],
  lookup: FetchedIndexLookup
): Promise<SettledDependency> {
  const { ref: choice } = await lookup.settle(readings);
  const location = locationOf(choice)!;
  const index = await lookup.indexAt(location);
  const namespace = namespaceOf(choice)?.name;
  const keys =
    choice.kind === "namespace"
      ? Object.keys(index.recipes)
          .filter((key) => key.startsWith(`${namespace}/`))
          .sort()
      : [shortKey(choice)];
  const range = readings.map(rangeOf).find((written) => written !== undefined);
  return {
    identity: location.identity,
    keys,
    ...(range === undefined ? {} : { range }),
  };
}
