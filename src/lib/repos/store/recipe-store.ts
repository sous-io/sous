/**
 * The machine-wide recipe store: one immutable directory per recipe version,
 * verified against its content hash.
 *
 * Layout (decision 11), rooted at `$SOUS_HOME/cache`. The first part is the
 * repository's CANONICAL IDENTITY (`github.com/sous-io/sous-recipes`), which is
 * several directories deep, because the store is shared by every project on the
 * machine and a project's short name for a repository is its own private label:
 *
 *     <root>/<repository identity>/<namespace>/<name>/<version>/
 *         .sous.entry.json     the marker describing this entry
 *         ...                  the recipe's files, exactly as fetched
 *
 * The store is disposable by design: everything in it is re-fetchable from the
 * pins in a project's lockfile, which is what lets `gc()` evict entries without
 * asking anyone. Content is never edited in place and is never symlinked into a
 * project; a build reads inputs from here and renders or copies its outputs.
 *
 * Writes are atomic. `put()` assembles the entry in a temporary directory that
 * is a SIBLING of its final home (same filesystem, so the rename cannot fail
 * across devices), hashes it, verifies it, and only then renames it into place.
 * A crash therefore leaves either the old entry or the new one, never a
 * half-copied tree.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ConfigError } from "../../errors.js";
import { INDEX_CACHE_DIRNAME, STORE_ENTRY_FILENAME } from "../formats/common.js";
import {
  parseStoreEntry,
  stringifyStoreEntry,
  type StoreEntry,
} from "../formats/store-entry.js";
import { resolveStoreRoot, type EnvLike } from "../../sous-home.js";
import { ensureStoreRootDirectory } from "../../../utils/sous-directory.js";
import { hashDirectory, hashesEqual } from "./hash.js";
import { identitySegments } from "../identity.js";
import type {
  RecipeStoreLike,
  StoreGcOptions,
  StoreGcReport,
  StoreHit,
  StoreKey,
} from "./contract.js";

/** Prefix of the temporary directories `put()` and `remove()` use. */
const TEMP_PREFIX = ".sous-tmp-";

/** Directory name never copied into the store. */
const GIT_DIR_NAME = ".git";

/**
 * How far below the store root a listing walk will look for an entry marker. A
 * hosted repository's entry sits six levels down (host, owner, name, namespace,
 * recipe, version) and a nested group path adds a few more; this is the guard
 * that stops a walk rather than a limit anyone is meant to reach.
 */
const MAX_STORE_DEPTH = 12;

/** Options accepted when constructing a store. */
export type RecipeStoreOptions = {
  /** Absolute path to the store root; every entry lives under it. */
  root: string;
  /**
   * Called with a complete, plain-language sentence whenever the store repairs
   * itself (a corrupted entry removed, an unreadable marker skipped). The store
   * writes nothing to the console itself, so a command can route these through
   * the shared formatting helpers.
   */
  onWarning?: (message: string) => void;
};

/**
 * Renders a store key the way error and warning messages name it:
 * `<identity>:namespace/name@version`.
 *
 * @param key - The key to describe.
 */
export function formatStoreKey(key: StoreKey): string {
  return `${key.identity}:${key.namespace}/${key.name}@${key.version}`;
}

/**
 * The key an entry is filed under, read back out of its own marker. The marker
 * records the repository's identity under `repo`, because that is what it is.
 *
 * @param entry - A validated store entry marker.
 */
export function storeKeyOf(entry: StoreEntry): StoreKey {
  return {
    identity: entry.repo,
    namespace: entry.namespace,
    name: entry.name,
    version: entry.version,
  };
}

/**
 * Rejects a key component that could escape the store root. Callers pass
 * validated names in practice; this is the belt that makes a bug in a provider
 * unable to write outside the cache.
 *
 * @param value - The component to check.
 * @param label - What the component is, for the error message.
 */
function assertSafeSegment(value: string, label: string): void {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new ConfigError(
      `Invalid store key: the ${label} '${value}' is not a usable directory name.\n` +
        `  Every part of a store key (the repository identity's segments, the namespace, ` +
        `the recipe name and the version) must be a single usable path segment.`
    );
  }
}

/** True when a directory entry is one of the store's own temporary directories. */
function isTempName(name: string): boolean {
  return name.startsWith(TEMP_PREFIX);
}

/**
 * Reads one marker file. Returns the validated entry, `undefined` when there is
 * no marker there at all, and the literal `"unreadable"` when there is one that
 * does not parse, which a caller reports rather than silently ignoring.
 *
 * @param markerPath - Absolute path of the marker file.
 */
async function readMarkerFile(
  markerPath: string
): Promise<StoreEntry | "unreadable" | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(markerPath, "utf8");
  } catch {
    return undefined;
  }

  try {
    return parseStoreEntry(JSON.parse(raw), markerPath);
  } catch {
    return "unreadable";
  }
}

/** An ISO 8601 timestamp with an offset, the shape every marker field uses. */
function nowIso(): string {
  return new Date().toISOString();
}

/** Removes a directory tree, ignoring the case where it is already gone. */
async function removeTree(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
}

/**
 * Copies a directory tree, skipping `.git` and any stale store marker, and
 * returns the total number of content bytes copied.
 *
 * Symlinks are skipped, and so is anything under one. The store holds real files
 * that the repository itself published, and the content hash skips links for the
 * same reason, so a copied tree hashes the same as its source on any machine.
 *
 * @param source - The directory to copy from.
 * @param destination - The directory to copy into; created if missing.
 */
async function copyTree(source: string, destination: string): Promise<number> {
  await fs.mkdir(destination, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  let bytes = 0;

  for (const entry of entries) {
    if (entry.name === GIT_DIR_NAME) continue;
    if (entry.name === STORE_ENTRY_FILENAME) continue;

    // A symlink is skipped whole, exactly as the hash skips it, so what lands in
    // the store is what the hash was computed over. Following one would copy
    // bytes the repository does not own and make the entry differ per machine.
    if (entry.isSymbolicLink()) continue;

    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);

    if (entry.isDirectory()) {
      bytes += await copyTree(from, to);
      continue;
    }
    if (!entry.isFile()) continue;

    let stats;
    try {
      stats = await fs.stat(from);
    } catch {
      continue;
    }

    await fs.copyFile(from, to);
    await fs.chmod(to, stats.mode & 0o777);
    bytes += stats.size;
  }

  return bytes;
}

/**
 * The machine-wide recipe store. Construct one with an explicit root, or use
 * `RecipeStore.fromEnv()` to take the root from `$SOUS_HOME/cache`.
 */
export class RecipeStore implements RecipeStoreLike {
  /** The absolute root directory of this store. */
  readonly root: string;

  /** Where self-repair notices go; a no-op when the caller supplied none. */
  private readonly onWarning: (message: string) => void;

  /**
   * @param options - The store root, and an optional warning sink.
   */
  constructor(options: RecipeStoreOptions) {
    this.root = path.normalize(path.resolve(options.root));
    this.onWarning = options.onWarning ?? (() => {});
  }

  /**
   * Builds a store rooted at the user-level cache directory. `SOUS_HOME` is
   * file-settable, so this reads the environment at call time; construct the
   * store after the env files have loaded.
   *
   * @param env - The environment to read; defaults to the live `process.env`.
   * @param options - An optional warning sink.
   */
  static fromEnv(
    env: EnvLike = process.env,
    options: Omit<RecipeStoreOptions, "root"> = {}
  ): RecipeStore {
    return new RecipeStore({ root: resolveStoreRoot(env), ...options });
  }

  /**
   * The directory an entry lives in, whether or not it exists.
   *
   * @param key - The recipe version to locate.
   */
  entryDir(key: StoreKey): string {
    const identity = identitySegments(key.identity);
    if (identity.length < 2) {
      throw new ConfigError(
        `Invalid store key: '${key.identity}' is not a repository identity.\n` +
          `  An identity is the repository's host followed by the path it lives at, as in ` +
          `'github.com/sous-io/sous-recipes'.`
      );
    }
    for (const segment of identity) assertSafeSegment(segment, "repository identity");
    assertSafeSegment(key.namespace, "namespace");
    assertSafeSegment(key.name, "recipe name");
    assertSafeSegment(key.version, "version");
    return path.join(this.root, ...identity, key.namespace, key.name, key.version);
  }

  /** The marker path for an entry. */
  private markerPath(key: StoreKey): string {
    return path.join(this.entryDir(key), STORE_ENTRY_FILENAME);
  }

  /**
   * Copies `sourceDir` into the store, hashes it, verifies it against
   * `expectedHash` when one is given, writes the marker and renames the result
   * into place atomically.
   *
   * Replacing an entry that is already present is allowed only when the new
   * content hashes the same as the old; a differing hash for the same version
   * means the upstream content changed under a published version, which is a
   * hard error rather than something to silently overwrite.
   *
   * @param key - The recipe version being stored.
   * @param sourceDir - The directory holding the fetched files.
   * @param expectedHash - The hash the caller (a lockfile pin, or a repo index)
   *   requires the content to have.
   */
  async put(key: StoreKey, sourceDir: string, expectedHash?: string): Promise<StoreEntry> {
    const target = this.entryDir(key);
    const parent = path.dirname(target);
    // The store root explains itself the first time anything is written into it.
    ensureStoreRootDirectory(this.root);
    await fs.mkdir(parent, { recursive: true });

    const stagingDir = path.join(
      parent,
      `${TEMP_PREFIX}${key.version}-${randomBytes(6).toString("hex")}`
    );

    try {
      const sizeBytes = await copyTree(sourceDir, stagingDir);
      const hash = await hashDirectory(stagingDir);

      if (expectedHash !== undefined && !hashesEqual(hash, expectedHash)) {
        throw new ConfigError(
          `The content of ${formatStoreKey(key)} does not match the hash it is pinned to.\n` +
            `  Expected: ${expectedHash}\n` +
            `  Actual:   ${hash}\n` +
            `  Nothing was written to the store. Either the upstream files changed under a ` +
            `published version, or the download was corrupted.`
        );
      }

      const existing = await this.readMarker(key);
      if (existing !== undefined && !hashesEqual(existing.hash, hash)) {
        throw new ConfigError(
          `The store already holds ${formatStoreKey(key)} with different content.\n` +
            `  Stored:   ${existing.hash}\n` +
            `  Incoming: ${hash}\n` +
            `  A published version is immutable, so sous will not overwrite it. Remove the ` +
            `entry deliberately if the upstream version was genuinely republished.`
        );
      }

      const entry: StoreEntry = {
        formatVersion: 1,
        repo: key.identity,
        namespace: key.namespace,
        name: key.name,
        version: key.version,
        hash,
        fetchedAt: existing?.fetchedAt ?? nowIso(),
        lastAccessAt: nowIso(),
        sizeBytes,
      };
      await fs.writeFile(
        path.join(stagingDir, STORE_ENTRY_FILENAME),
        stringifyStoreEntry(entry),
        "utf8"
      );

      await this.swapIntoPlace(stagingDir, target);
      return entry;
    } finally {
      await removeTree(stagingDir);
    }
  }

  /**
   * Renames a staged directory over the entry's final location. When something
   * is already there it is moved aside first and deleted afterwards, so the
   * window in which neither tree is in place is a single rename wide.
   *
   * @param stagingDir - The fully assembled entry.
   * @param target - Where the entry belongs.
   */
  private async swapIntoPlace(stagingDir: string, target: string): Promise<void> {
    const displaced = path.join(
      path.dirname(target),
      `${TEMP_PREFIX}old-${randomBytes(6).toString("hex")}`
    );
    let displacedSomething = false;

    try {
      await fs.rename(target, displaced);
      displacedSomething = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }

    try {
      await fs.rename(stagingDir, target);
    } catch (error) {
      if (displacedSomething) await fs.rename(displaced, target);
      throw error;
    }

    if (displacedSomething) await removeTree(displaced);
  }

  /**
   * Reads and validates an entry's marker, returning undefined when the entry
   * is absent. An unreadable or invalid marker is reported through the warning
   * sink and treated as absent, so a damaged store heals on the next fetch.
   *
   * @param key - The entry to read.
   */
  private async readMarker(key: StoreKey): Promise<StoreEntry | undefined> {
    const markerPath = this.markerPath(key);
    const marker = await readMarkerFile(markerPath);

    if (marker === "unreadable") {
      this.onWarning(
        `The store entry marker at ${markerPath} could not be read, so the cached copy of ` +
          `${formatStoreKey(key)} was ignored. It will be fetched again.`
      );
      return undefined;
    }
    return marker;
  }

  /**
   * Returns the entry when it is present and its content still hashes to what
   * the marker records, touching its last-access time so collection sees the
   * use. An entry whose content no longer verifies is removed and reported as
   * absent, with a warning.
   *
   * @param key - The recipe version to look up.
   */
  async get(key: StoreKey): Promise<StoreHit | undefined> {
    const entry = await this.readMarker(key);
    if (entry === undefined) return undefined;

    const dir = this.entryDir(key);
    const actual = await hashDirectory(dir);
    if (!hashesEqual(actual, entry.hash)) {
      await this.remove(key);
      this.onWarning(
        `The cached copy of ${formatStoreKey(key)} did not match its recorded content hash, ` +
          `so it was removed from the store and will be fetched again.`
      );
      return undefined;
    }

    const touched: StoreEntry = { ...entry, lastAccessAt: nowIso() };
    await this.writeMarker(key, touched);
    return { dir, entry: touched };
  }

  /**
   * Writes a marker back over an existing entry. Only the marker changes;
   * content is never touched, and the marker is excluded from the content hash,
   * so touching an entry cannot invalidate it.
   *
   * @param key - The entry to write the marker for.
   * @param entry - The marker contents.
   */
  private async writeMarker(key: StoreKey, entry: StoreEntry): Promise<void> {
    await fs.writeFile(this.markerPath(key), stringifyStoreEntry(entry), "utf8");
  }

  /**
   * True when an entry with a readable marker is present. This is a cheap
   * presence check and does NOT verify the content hash; use `get()` when the
   * answer has to be trustworthy.
   *
   * @param key - The recipe version to check for.
   */
  async has(key: StoreKey): Promise<boolean> {
    return (await this.readMarker(key)) !== undefined;
  }

  /**
   * Removes an entry and any directories its removal leaves empty, so the store
   * does not accumulate an empty skeleton of every repo it ever held.
   *
   * @param key - The recipe version to remove.
   */
  async remove(key: StoreKey): Promise<void> {
    const target = this.entryDir(key);
    await removeTree(target);
    await this.pruneEmptyParents(path.dirname(target));
  }

  /**
   * Deletes empty directories from `dir` upwards, stopping at the store root
   * (which is left in place even when empty).
   *
   * @param dir - The deepest directory to consider.
   */
  private async pruneEmptyParents(dir: string): Promise<void> {
    let current = dir;
    while (current.startsWith(this.root + path.sep)) {
      try {
        const remaining = await fs.readdir(current);
        if (remaining.length > 0) return;
        await fs.rmdir(current);
      } catch {
        return;
      }
      current = path.dirname(current);
    }
  }

  /**
   * Every entry in the store, read from the markers. Directories without a
   * readable marker are skipped, so a partially removed tree never breaks a
   * listing.
   */
  async list(): Promise<StoreEntry[]> {
    const entries: StoreEntry[] = [];
    await this.collectEntries(this.root, 0, entries);
    return entries;
  }

  /**
   * Walks the store looking for entry markers. A repository identity is several
   * directories deep and a self-hosted group path may be deeper still, so the
   * depth is not fixed: any directory holding a readable marker IS an entry, and
   * nothing below it is walked.
   *
   * @param dir - The directory to look in.
   * @param depth - How far below the store root that directory is.
   * @param into - The entries found so far, added to in place.
   */
  private async collectEntries(
    dir: string,
    depth: number,
    into: StoreEntry[]
  ): Promise<void> {
    // Nothing sensible is ever this deep, and a loop through a symlinked
    // directory would otherwise never end.
    if (depth > MAX_STORE_DEPTH) return;

    for (const child of await this.childDirectories(dir)) {
      // The index cache is a sibling of the entries, inside the same root.
      if (depth === 0 && child === INDEX_CACHE_DIRNAME) continue;

      const childDir = path.join(dir, child);
      const marker = await readMarkerFile(path.join(childDir, STORE_ENTRY_FILENAME));
      if (marker === "unreadable") {
        this.onWarning(
          `The store entry marker at ${path.join(childDir, STORE_ENTRY_FILENAME)} could ` +
            `not be read, so that cached copy was left out of the listing. It will be ` +
            `fetched again when something needs it.`
        );
        continue;
      }
      if (marker !== undefined) {
        into.push(marker);
        continue;
      }
      await this.collectEntries(childDir, depth + 1, into);
    }
  }

  /**
   * Directory names directly inside `dir`, with the store's own temporary
   * directories filtered out. A missing directory lists as empty.
   *
   * @param dir - The directory to read.
   */
  private async childDirectories(dir: string): Promise<string[]> {
    let found;
    try {
      found = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return found
      .filter((entry) => entry.isDirectory() && !isTempName(entry.name))
      .map((entry) => entry.name);
  }

  /**
   * Evicts least-recently-used entries until the store fits inside `maxBytes`.
   * Entries listed in `keep` (everything a lockfile still pins) are never
   * evicted, even when that leaves the store over its cap; a cache that is too
   * small is a nuisance, while evicting a pinned entry breaks a build.
   *
   * @param options - The size cap, the keys to protect, and whether to only report.
   */
  async gc(options: StoreGcOptions): Promise<StoreGcReport> {
    const entries = await this.list();
    const bytesBefore = entries.reduce((total, entry) => total + entry.sizeBytes, 0);

    const protectedKeys = new Set(
      (options.keep ?? []).map((key) => formatStoreKey(key))
    );

    // Least recently used first; ties break on the key so a pass is deterministic.
    const candidates = [...entries].sort((a, b) => {
      if (a.lastAccessAt !== b.lastAccessAt) {
        return a.lastAccessAt < b.lastAccessAt ? -1 : 1;
      }
      return formatStoreKey(storeKeyOf(a)) < formatStoreKey(storeKeyOf(b)) ? -1 : 1;
    });

    const evicted: StoreEntry[] = [];
    const kept: StoreEntry[] = [];
    let bytesAfter = bytesBefore;

    for (const entry of candidates) {
      if (
        bytesAfter <= options.maxBytes ||
        protectedKeys.has(formatStoreKey(storeKeyOf(entry)))
      ) {
        kept.push(entry);
        continue;
      }
      if (options.dryRun !== true) await this.remove(storeKeyOf(entry));
      evicted.push(entry);
      bytesAfter -= entry.sizeBytes;
    }

    return { evicted, kept, bytesBefore, bytesAfter };
  }
}
