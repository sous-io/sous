/**
 * An in-memory recipe store for tests.
 *
 * Everything that fills or reads the store (the providers, the resolver, the
 * lockfile restore) is written against `RecipeStoreLike` in
 * `src/lib/repos/store/contract.ts`, so a test can hand it this fake instead of
 * the real, disk-backed store. Nothing here touches the filesystem: `put`
 * records the source directory it was given and a hash the test supplies, and
 * `get` hands both back.
 */

import path from "node:path";
import type {
  RecipeStoreLike,
  StoreGcOptions,
  StoreGcReport,
  StoreHit,
  StoreKey,
} from "../../lib/repos/store/contract.js";
import type { StoreEntry } from "../../lib/repos/formats/store-entry.js";

/** Options for a fake store. */
export type FakeRecipeStoreOptions = {
  /** The value `root` reports. Defaults to `/fake-store`. */
  root?: string;
  /**
   * The hash `put` records when the caller supplies no expected hash. Defaults
   * to a fixed, obviously fake value.
   */
  defaultHash?: string;
};

/** A placeholder hash used when a test does not care what the hash is. */
export const FAKE_HASH = `sha256-${"0".repeat(64)}`;

/** The key an entry is filed under, matching the on-disk store's layout. */
function keyOf(key: StoreKey): string {
  return `${key.repo}/${key.namespace}/${key.name}/${key.version}`;
}

/** A fixed timestamp, so entries never differ between runs. */
const FIXED_TIME = "2026-01-01T00:00:00.000Z";

/**
 * An in-memory `RecipeStoreLike`. Also records every `put` in `puts`, so a test
 * can assert on what a restore or an install actually fetched.
 */
export class FakeRecipeStore implements RecipeStoreLike {
  readonly root: string;

  /** Every put this store has seen, in order. */
  readonly puts: Array<{ key: StoreKey; sourceDir: string; expectedHash?: string }> = [];

  /** Every removal this store has seen, in order. */
  readonly removals: StoreKey[] = [];

  private readonly defaultHash: string;

  private readonly entries = new Map<string, StoreEntry>();

  constructor(options: FakeRecipeStoreOptions = {}) {
    this.root = options.root ?? "/fake-store";
    this.defaultHash = options.defaultHash ?? FAKE_HASH;
  }

  entryDir(key: StoreKey): string {
    return path.join(this.root, key.repo, key.namespace, key.name, key.version);
  }

  async put(key: StoreKey, sourceDir: string, expectedHash?: string): Promise<StoreEntry> {
    this.puts.push({ key, sourceDir, ...(expectedHash === undefined ? {} : { expectedHash }) });
    const entry: StoreEntry = {
      formatVersion: 1,
      repo: key.repo,
      namespace: key.namespace,
      name: key.name,
      version: key.version,
      hash: expectedHash ?? this.defaultHash,
      fetchedAt: FIXED_TIME,
      lastAccessAt: FIXED_TIME,
      sizeBytes: 0,
    };
    this.entries.set(keyOf(key), entry);
    return entry;
  }

  async get(key: StoreKey): Promise<StoreHit | undefined> {
    const entry = this.entries.get(keyOf(key));
    if (entry === undefined) return undefined;
    return { dir: this.entryDir(key), entry };
  }

  async has(key: StoreKey): Promise<boolean> {
    return this.entries.has(keyOf(key));
  }

  async remove(key: StoreKey): Promise<void> {
    this.removals.push(key);
    this.entries.delete(keyOf(key));
  }

  async list(): Promise<StoreEntry[]> {
    return [...this.entries.values()];
  }

  /** The fake store has no size, so a collection pass always keeps everything. */
  async gc(_options: StoreGcOptions): Promise<StoreGcReport> {
    const kept = await this.list();
    return { evicted: [], kept, bytesBefore: 0, bytesAfter: 0 };
  }

  /**
   * Seeds an entry without going through `put`, for a test that needs the store
   * to already hold something.
   *
   * @param key - Which recipe version to seed.
   * @param hash - The content hash to record for it.
   */
  seed(key: StoreKey, hash: string = this.defaultHash): StoreEntry {
    const entry: StoreEntry = {
      formatVersion: 1,
      repo: key.repo,
      namespace: key.namespace,
      name: key.name,
      version: key.version,
      hash,
      fetchedAt: FIXED_TIME,
      lastAccessAt: FIXED_TIME,
      sizeBytes: 0,
    };
    this.entries.set(keyOf(key), entry);
    return entry;
  }
}
