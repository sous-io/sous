/**
 * Settling, at release time, a dependency that reads more than one way.
 *
 * Most dependencies say exactly what they mean: `workflow/alpha`, or
 * `github://owner/repo/workflow/alpha`. Two kinds do not: a GitLab URL with
 * nested groups, which does not say where the project path ends, and a browser
 * URL copied from a host's file view, which names a folder whose recipe only
 * that repository's index can say.
 *
 * `sous repo release` settles each of them once, by fetching the index of every
 * candidate repository through the provider layer and keeping the reading whose
 * index publishes what was named. A network failure fails the release: a
 * release never falls through to the next reading, because the reading it fell
 * through to could be the wrong one. Two readings that both publish what is
 * named are a genuine tie, and an error naming the spelling that reads one way.
 */

import { ConfigError } from "../../../lib/errors.js";
import { INDEX_FILENAME } from "../../../lib/repos/formats/common.js";
import { parseIndexFile, type IndexFile } from "../../../lib/repos/formats/index-file.js";
import {
  builtInProviders,
  providerById,
  type ProviderOptions,
  type RepoProvider,
} from "../../../lib/repos/providers/index.js";
import { formatRef } from "../format.js";
import { locationOf } from "../parts.js";
import type { RefLocation, SousRef } from "../types.js";
import { CatalogMatcher, catalogRepoOfIndex } from "./catalog-matcher.js";
import type { RefLookup, RefMatch } from "./ref-lookup.js";

/** Fetches the index of the repository at a location. */
export type IndexFetcher = (location: RefLocation) => Promise<IndexFile>;

/** What a `FetchedIndexLookup` may be given. */
export type FetchedIndexLookupOptions = {
  /** The providers to fetch through. Defaults to the built-ins. */
  providers?: RepoProvider[];
  /** Testing seams handed to every index fetch by the default fetcher. */
  providerOptions?: ProviderOptions;
  /** Replaces the default fetcher, which goes through the provider layer. */
  fetchIndex?: IndexFetcher;
  /** What the ref being settled is called in an error, such as "dependency". Defaults to "ref". */
  subject?: string;
};

/** A failure, in a sentence. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Answers a located candidate by fetching the index of the repository it names
 * (once per repository) and matching the candidate against it. A candidate
 * with no location names no repository to fetch from and matches nothing.
 */
export class FetchedIndexLookup implements RefLookup {
  private readonly providers: RepoProvider[];
  private readonly fetcher: IndexFetcher;
  private readonly indexes = new Map<string, Promise<IndexFile>>();

  /**
   * @param options - The providers and testing seams, or a replacement fetcher.
   */
  constructor(private readonly options: FetchedIndexLookupOptions = {}) {
    this.providers = options.providers ?? builtInProviders();
    this.fetcher = options.fetchIndex ?? ((location) => this.fetchThroughProvider(location));
  }

  async find(candidate: SousRef): Promise<RefMatch[]> {
    const location = locationOf(candidate);
    if (location === undefined) return [];

    let index: IndexFile;
    try {
      index = await this.indexAt(location);
    } catch (error) {
      const subject = this.options.subject ?? "ref";
      const folder = candidate.kind === "repo" && candidate.browsed !== undefined;
      throw new ConfigError(
        `the ${subject} reads ${folder ? "as a folder in" : "as something in"} the repository ` +
          `at ${location.url}, and its index could not be read, so the release cannot settle ` +
          `what it means. A release never guesses past an index it could not read.\n` +
          `  ${describe(error)}`
      );
    }

    return new CatalogMatcher([catalogRepoOfIndex(index, { location })]).match(candidate);
  }

  /**
   * The one reading of a written ref that the fetched indexes confirm: every
   * reading is looked up, and exactly one may publish what it names.
   *
   * @param candidates - Every reading of the written ref.
   * @returns The one match.
   * @throws A ConfigError when no repository publishes it, when several do (naming the
   *   `/*` spelling that reads one way), or when an index could not be fetched.
   */
  async settle(candidates: SousRef[]): Promise<RefMatch> {
    const choices: RefMatch[] = [];
    for (const candidate of candidates) choices.push(...(await this.find(candidate)));

    if (choices.length === 0) {
      throw new ConfigError(
        `no repository it could name publishes what it names. It was read as:\n` +
          candidates.map((candidate) => `    ${formatRef(candidate, this.providers)}`).join("\n")
      );
    }
    if (choices.length > 1) {
      const namespace = choices.find((choice) => choice.ref.kind === "namespace") ?? choices[0]!;
      const written = formatRef(namespace.ref, this.providers);
      throw new ConfigError(
        `it names more than one thing, and each of these publishes it:\n` +
          choices.map((choice) => `    ${formatRef(choice.ref, this.providers)}`).join("\n") +
          `\n  Write the one you mean. A namespace is written with '/*' after it, as in ` +
          `'${namespace.ref.kind === "namespace" ? `${written}/*` : written}', and a recipe as ` +
          `its canonical locator above.`
      );
    }
    return choices[0]!;
  }

  /**
   * The index at a location, fetched once per repository.
   *
   * @param location - Where the repository lives.
   */
  indexAt(location: RefLocation): Promise<IndexFile> {
    let pending = this.indexes.get(location.identity);
    if (pending === undefined) {
      pending = this.fetcher(location);
      this.indexes.set(location.identity, pending);
    }
    return pending;
  }

  /** Fetches and validates the index at a location, through its provider. */
  private async fetchThroughProvider(location: RefLocation): Promise<IndexFile> {
    const provider = providerById(location.provider, this.providers);
    /* c8 ignore next */
    if (provider === undefined) throw new Error(`sous has no '${location.provider}' provider.`);
    const fetched = await provider.fetchIndex(
      provider.canonicalize(location.url),
      this.options.providerOptions ?? {}
    );
    return parseIndexFile(JSON.parse(fetched.text), `${location.url}/${INDEX_FILENAME}`);
  }
}
