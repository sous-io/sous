/**
 * The contract between the recipe store (Phase 2a) and everything that fills or reads it
 * (providers, resolver, lockfile restore, the build). Both sides are written against this
 * file; keep it dependency-free so either side can compile without the other.
 */
import type { StoreEntry } from "../formats/store-entry.js";

/**
 * Identifies one recipe version inside one repository.
 *
 * The store is MACHINE-WIDE, so it is keyed by the repository's canonical
 * identity rather than by a project's short name for it: two projects that call
 * the same repository different things still share one cached copy, and two
 * projects that use the same short name for different repositories never
 * collide.
 */
export interface StoreKey {
  /** The repository's canonical identity, such as `github.com/sous-io/sous-recipes`. */
  identity: string;
  namespace: string;
  name: string;
  version: string;
}

/** What a successful lookup returns: where the files are and the verified marker. */
export interface StoreHit {
  dir: string;
  entry: StoreEntry;
}

/** Options for a garbage-collection pass. */
export interface StoreGcOptions {
  /** Upper bound for the whole store in bytes; entries are evicted least-recently-used first. */
  maxBytes: number;
  /** Keys that must survive no matter what (everything a lockfile still pins). */
  keep?: StoreKey[];
  dryRun?: boolean;
}

export interface StoreGcReport {
  evicted: StoreEntry[];
  kept: StoreEntry[];
  bytesBefore: number;
  bytesAfter: number;
}

/** The recipe store: one immutable folder per recipe version, verified against its content hash. */
export interface RecipeStoreLike {
  /** The absolute root directory of this store. */
  readonly root: string;
  /** The directory an entry lives in (whether or not it exists). */
  entryDir(key: StoreKey): string;
  /** Copies `sourceDir` into the store, hashes it, verifies against `expectedHash` when given, writes the marker. */
  put(key: StoreKey, sourceDir: string, expectedHash?: string): Promise<StoreEntry>;
  /** Returns the entry if present and its hash still verifies; touches last access. Undefined when absent. */
  get(key: StoreKey): Promise<StoreHit | undefined>;
  has(key: StoreKey): Promise<boolean>;
  remove(key: StoreKey): Promise<void>;
  list(): Promise<StoreEntry[]>;
  gc(options: StoreGcOptions): Promise<StoreGcReport>;
}

/** Computes the canonical `sha256-<hex>` content hash of a directory tree. */
export type DirectoryHasher = (dir: string) => Promise<string>;
