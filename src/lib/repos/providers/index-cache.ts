/**
 * The index cache.
 *
 * Adding a repository fetches exactly one file, its `sous.index.json`, and that
 * file is all sous needs to resolve a ref, enumerate versions and decide what to
 * download. The cache keeps one copy per repository under
 * `<storeRoot>/_indexes/`, beside a small sidecar recording when it was fetched
 * and what the host called that version of it.
 *
 * The rule the whole Repositories system follows applies here too: a failed
 * upstream check never breaks a build. When a refetch fails and a cached copy
 * exists, the cached copy is used and the failure is reported as a warning.
 *
 * The cache takes the store's root directory as a plain string, so it does not
 * depend on the store implementation at all.
 */

import fs from "node:fs";
import path from "node:path";
import { parseIndexFile, type IndexFile } from "../formats/index-file.js";
import { INDEX_CACHE_DIRNAME, stableJsonStringify } from "../formats/common.js";
import { identitySegments } from "../identity.js";
import { ConfigError, isConfigError } from "../../errors.js";
import { warning } from "../../../utils/formatting.js";
// The freshness window has one definition, and it lives with the rest of the
// freshness rules; that module only borrows a type from here, so nothing loads
// in a circle at run time.
import { DEFAULT_FRESHNESS_SECONDS } from "../store/settings.js";
import type { ProviderOptions, RepoProvider } from "./provider.js";
import { ensureIndexCacheDirectory } from "../../../utils/sous-directory.js";

export { INDEX_CACHE_DIRNAME };

/** The suffix of the sidecar written beside each cached index. */
export const INDEX_SIDECAR_SUFFIX = ".meta.json";

/**
 * What sous remembers about a cached index. Written as JSON beside the index
 * itself; a missing or unreadable sidecar simply means "no idea", never an
 * error.
 */
export type IndexMeta = {
  /** When the cached copy was fetched. */
  fetchedAt: string;
  /** The entity tag the host sent for that copy, when it sent one. */
  etag?: string;
  /** The git ref it was read at. */
  ref?: string;
  /** When sous last asked upstream whether there was anything newer. */
  lastCheckedAt?: string;
};

/** Where a returned index came from. */
export type IndexSource = "cache" | "network" | "stale";

/** What a cache lookup returns. */
export type IndexLookup = {
  /** The validated index. */
  index: IndexFile;
  /** Whether it came from the cache, from the network, or from a stale fallback. */
  source: IndexSource;
  /** What sous remembers about the copy that was returned. */
  meta: IndexMeta;
};

/** Which repository to fetch, and how fresh the answer has to be. */
export type GetIndexOptions = {
  /** The repository URL, used when a fetch is needed. */
  url: string;
  /** The provider the repository entry names, when it names one. */
  provider?: string;
  /** How old a cached copy may be, in seconds. Defaults to five minutes. */
  maxAgeSeconds?: number;
  /** When true, refetch regardless of how fresh the cached copy is. */
  force?: boolean;
  /**
   * What to call the repository in a message. A project's short name for it is
   * what the person reading wrote in their own config, so that is what they are
   * shown; the identity is used when nothing supplies one.
   */
  label?: string;
};

/** How the cache is built. */
export type IndexCacheOptions = {
  /** The store's root directory; the cache lives in a subdirectory of it. */
  storeRoot: string;
  /**
   * How a provider is chosen for a repository URL. Defaults to the built-in
   * providers; injected in tests, and by anyone with a provider list of their
   * own.
   */
  resolveProvider: (url: string, providerId?: string) => RepoProvider;
  /** Options handed to every provider call (environment, fetch, subprocess runner). */
  providerOptions?: ProviderOptions;
  /** The clock, so tests can decide what "now" means. */
  now?: () => Date;
  /** Where warnings go. Defaults to the console warning banner. */
  warn?: (message: string) => void;
};

/** One cached repository index, plus the machinery to keep it current. */
export class IndexCache {
  private readonly storeRoot: string;

  private readonly resolveProvider: (url: string, providerId?: string) => RepoProvider;

  private readonly providerOptions: ProviderOptions;

  private readonly now: () => Date;

  private readonly warn: (message: string) => void;

  constructor(options: IndexCacheOptions) {
    this.storeRoot = options.storeRoot;
    this.resolveProvider = options.resolveProvider;
    this.providerOptions = options.providerOptions ?? {};
    this.now = options.now ?? (() => new Date());
    this.warn = options.warn ?? warning;
  }

  /** The directory cached indexes live in. */
  get directory(): string {
    return path.join(this.storeRoot, INDEX_CACHE_DIRNAME);
  }

  /**
   * Where a repository's cached index is written. The identity is several
   * segments, so it becomes several directories, exactly as it does in the
   * store: `_indexes/github.com/sous-io/sous-recipes.json`.
   *
   * @param identity - The repository's canonical identity.
   */
  indexPath(identity: string): string {
    const segments = identitySegments(identity);
    const last = segments.pop() ?? identity;
    return path.join(this.directory, ...segments, `${last}.json`);
  }

  /**
   * Where a repository's index sidecar is written, beside its index.
   *
   * @param identity - The repository's canonical identity.
   */
  sidecarPath(identity: string): string {
    const segments = identitySegments(identity);
    const last = segments.pop() ?? identity;
    return path.join(this.directory, ...segments, `${last}${INDEX_SIDECAR_SUFFIX}`);
  }

  /**
   * Reads what sous remembers about a cached index. Returns undefined when
   * there is no sidecar or it cannot be read; the sidecar is a convenience, and
   * losing it only costs a refetch.
   *
   * @param identity - The repository's canonical identity.
   */
  readMeta(identity: string): IndexMeta | undefined {
    try {
      const raw = JSON.parse(fs.readFileSync(this.sidecarPath(identity), "utf8")) as IndexMeta;
      if (typeof raw?.fetchedAt !== "string") return undefined;
      return raw;
    } catch {
      return undefined;
    }
  }

  /**
   * Writes what sous remembers about a cached index.
   *
   * @param identity - The repository's canonical identity.
   * @param meta - What to record.
   */
  writeMeta(identity: string, meta: IndexMeta): void {
    const file = this.sidecarPath(identity);
    this.prepareDirectoryFor(file);
    fs.writeFileSync(file, stableJsonStringify(meta), "utf8");
  }

  /**
   * Makes sure the cache directory exists and explains itself, and that the
   * subdirectories an identity turns into are there too.
   *
   * @param filePath - The file about to be written.
   */
  private prepareDirectoryFor(filePath: string): void {
    ensureIndexCacheDirectory(this.directory);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  /**
   * Reads and validates the cached index, or undefined when there is none. A
   * cached file that no longer parses is treated as absent, since it is only a
   * copy of something upstream still has.
   *
   * @param identity - The repository's canonical identity.
   */
  readCached(identity: string): IndexFile | undefined {
    const file = this.indexPath(identity);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
    try {
      return parseIndexFile(JSON.parse(text), file);
    } catch {
      return undefined;
    }
  }

  /**
   * True when the cached copy is younger than the given window.
   *
   * @param meta - What sous remembers about the cached copy.
   * @param maxAgeSeconds - How old the copy may be.
   */
  isFresh(meta: IndexMeta | undefined, maxAgeSeconds: number): boolean {
    if (meta === undefined) return false;
    const fetched = Date.parse(meta.fetchedAt);
    if (Number.isNaN(fetched)) return false;
    const ageSeconds = (this.now().getTime() - fetched) / 1000;
    return ageSeconds >= 0 && ageSeconds < maxAgeSeconds;
  }

  /**
   * Returns a repository's index: the cached copy while it is fresh, otherwise a
   * fresh fetch through the provider. When the fetch fails and a cached copy
   * exists, the cached copy is returned and the failure is warned about; when
   * there is no cached copy, the failure is raised.
   *
   * @param identity - The repository's canonical identity.
   * @param options - The repository URL, its provider, and the freshness window.
   */
  async getIndex(identity: string, options: GetIndexOptions): Promise<IndexLookup> {
    const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_FRESHNESS_SECONDS;
    const meta = this.readMeta(identity);

    if (options.force !== true && this.isFresh(meta, maxAgeSeconds)) {
      const cached = this.readCached(identity);
      if (cached !== undefined) return { index: cached, source: "cache", meta: meta! };
    }

    try {
      return await this.refresh(identity, options);
    } catch (error) {
      const cached = this.readCached(identity);
      if (cached === undefined) throw error;

      const reason = isConfigError(error)
        ? (error as ConfigError).message
        : (error as Error).message;
      this.warn(
        `Sous could not check the repository '${options.label ?? identity}' for updates, ` +
          `so it is using the copy of its index that it already had.\n${reason}`
      );
      const stale: IndexMeta = meta ?? { fetchedAt: new Date(0).toISOString() };
      return { index: cached, source: "stale", meta: stale };
    }
  }

  /**
   * Fetches a repository's index through its provider, validates it, and writes
   * both the index and its sidecar. Raises rather than falling back; `getIndex`
   * is where the last-good behavior lives.
   *
   * @param identity - The repository's canonical identity.
   * @param options - The repository URL and its provider.
   */
  async refresh(identity: string, options: GetIndexOptions): Promise<IndexLookup> {
    const provider = this.resolveProvider(options.url, options.provider);
    const repo = provider.canonicalize(options.url);
    const fetched = await provider.fetchIndex(repo, this.providerOptions);

    let parsed: unknown;
    try {
      parsed = JSON.parse(fetched.text);
    } catch (error) {
      throw new ConfigError(
        `The index that ${options.url} published is not valid JSON.\n` +
          `  ${(error as Error).message}\n` +
          `  A repository's index is written by 'sous repo release'; this one may be ` +
          `damaged or may not be a sous repository at all.`
      );
    }

    const index = parseIndexFile(parsed, `${options.url} (${fetched.ref})`);
    const timestamp = this.now().toISOString();
    const meta: IndexMeta = {
      fetchedAt: timestamp,
      lastCheckedAt: timestamp,
      ref: fetched.ref,
      ...(fetched.etag === undefined ? {} : { etag: fetched.etag }),
    };

    const file = this.indexPath(identity);
    this.prepareDirectoryFor(file);
    fs.writeFileSync(file, stableJsonStringify(index), "utf8");
    this.writeMeta(identity, meta);

    return { index, source: "network", meta };
  }

  /**
   * Forgets a repository's cached index and sidecar, which is what removing a
   * repository from a project does.
   *
   * @param identity - The repository's canonical identity.
   */
  forget(identity: string): void {
    fs.rmSync(this.indexPath(identity), { force: true });
    fs.rmSync(this.sidecarPath(identity), { force: true });
  }
}
