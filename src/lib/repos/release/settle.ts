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

import { parseIndexFile, type IndexFile } from "../formats/index-file.js";
import { INDEX_FILENAME } from "../formats/common.js";
import {
  builtInProviders,
  providerById,
  type ProviderOptions,
  type RepoProvider,
} from "../providers/index.js";
import {
  formatRef,
  isBrowsedReading,
  isNamedReading,
  parseRef,
  refKey,
  type ParsedRef,
  type RefLocation,
  type RefReading,
} from "../../refs/parse.js";
import { settleInIndex } from "../../refs/settle.js";
import { RefSource } from "../../refs/scopes.js";
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
export function needsSettling(readings: RefReading[]): boolean {
  return readings.length > 1 || readings.some(isBrowsedReading);
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
  const providers = options.providers ?? builtInProviders();
  const settled = new Map<string, SettledDependency>();
  const problems: ValidationProblem[] = [];
  const indexes = new Map<string, Promise<IndexFile>>();

  const indexOf = (location: RefLocation): Promise<IndexFile> => {
    let pending = indexes.get(location.identity);
    if (pending === undefined) {
      pending = fetchIndexAt(location, providers, options.providerOptions ?? {});
      indexes.set(location.identity, pending);
    }
    return pending;
  };

  for (const recipe of validation.recipes) {
    const declared = [...(recipe.manifest.depends ?? []), ...(recipe.manifest.subscribes ?? [])];
    for (const written of declared) {
      const trimmed = written.trim();
      if (settled.has(trimmed)) continue;

      let readings: RefReading[];
      try {
        readings = parseRef(trimmed, RefSource.Manifest, providers);
      } catch {
        // Validation already reported a dependency that does not parse.
        continue;
      }
      if (!needsSettling(readings)) continue;

      const where = `${recipe.path} ('${trimmed}')`;
      try {
        settled.set(trimmed, await settleOne(trimmed, readings, indexOf, providers));
      } catch (error) {
        problems.push({ level: "error", where, message: describeError(error) });
      }
    }
  }

  return { settled, problems };
}

/**
 * Settles one dependency: fetches the index behind each reading, and keeps the
 * one reading that publishes what it names.
 *
 * @param written - The dependency as written.
 * @param readings - Every reading of it.
 * @param indexOf - Fetches (once) the index at a location.
 * @param providers - The providers, for formatting.
 */
async function settleOne(
  written: string,
  readings: RefReading[],
  indexOf: (location: RefLocation) => Promise<IndexFile>,
  providers: RepoProvider[]
): Promise<SettledDependency> {
  const found: Array<{ reading: RefReading; settled: ParsedRef[]; index: IndexFile }> = [];

  for (const reading of readings) {
    const location = reading.location;
    /* c8 ignore next */
    if (location === undefined) continue;

    let index: IndexFile;
    try {
      index = await indexOf(location);
    } catch (error) {
      throw new Error(
        `the dependency reads ${readings.length === 1 ? "as a folder in" : "as something in"} ` +
          `the repository at ${location.url}, and its index could not be read, so the release ` +
          `cannot settle what it means. A release never guesses past an index it could not ` +
          `read.\n  ${describeError(error)}`
      );
    }

    const settled = settleInIndex(reading, {
      namespaces: Object.keys(index.namespaces),
      recipes: index.recipes,
    });
    if (settled.length > 0) found.push({ reading, settled, index });
  }

  if (found.length === 0) {
    throw new Error(
      `no repository it could name publishes what it names. It was read as:\n` +
        readings.map((reading) => `    ${formatRef(reading, providers)}`).join("\n")
    );
  }

  const choices = found.flatMap((entry) => entry.settled);
  if (choices.length > 1) {
    throw new Error(
      `it names more than one thing, and each of these publishes it:\n` +
        choices.map((choice) => `    ${formatRef(choice, providers)}`).join("\n") +
        `\n  Write the one you mean. A namespace is written with '/*' after it, as in ` +
        `'${spelledOut(choices.find((choice) => choice.recipe === undefined) ?? choices[0]!, providers)}', ` +
        `and a recipe as its canonical locator above.`
    );
  }

  const { index } = found[0]!;
  const choice = choices[0]!;
  const keys =
    choice.recipe === undefined
      ? Object.keys(index.recipes)
          .filter((key) => key.startsWith(`${choice.namespace}/`))
          .sort()
      : [refKey(choice)];
  const range = "range" in found[0]!.reading ? found[0]!.reading.range : undefined;
  return {
    identity: choice.location!.identity,
    keys,
    ...(range === undefined ? {} : { range }),
  };
}

/** A reading spelled so it reads one way: a namespace with `/*` after it. */
function spelledOut(reading: ParsedRef, providers: RepoProvider[]): string {
  const written = formatRef(reading, providers);
  return reading.recipe === undefined && isNamedReading(reading) ? `${written}/*` : written;
}

/**
 * Fetches and validates the index at a location, through its provider.
 *
 * @param location - Where the repository lives.
 * @param providers - The providers to fetch through.
 * @param options - Testing seams.
 */
async function fetchIndexAt(
  location: RefLocation,
  providers: RepoProvider[],
  options: ProviderOptions
): Promise<IndexFile> {
  const provider = providerById(location.provider, providers);
  /* c8 ignore next */
  if (provider === undefined) throw new Error(`sous has no '${location.provider}' provider.`);
  const fetched = await provider.fetchIndex(provider.canonicalize(location.url), options);
  return parseIndexFile(JSON.parse(fetched.text), `${location.url}/${INDEX_FILENAME}`);
}
