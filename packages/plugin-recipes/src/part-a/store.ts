/**
 * The machine-wide recipe store: one immutable directory per recipe version, verified
 * against its content hash.
 *
 * ```text
 * <root>/<repository identity>/<namespace>/<name>/<version>/
 *     .sous.entry.json     the marker describing this entry
 *     ...                  the recipe's files, exactly as fetched
 * ```
 *
 * The store is keyed by a repository's canonical identity, never a project's short name, since
 * every project on the machine shares it. Everything in it can be fetched again from a lockfile's
 * pins, which is what lets `gc` evict entries without asking. Writes are atomic: `put` assembles an
 * entry in a sibling temporary directory and renames it into place.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "@sous-io/plugin-api";
import type { ContentHash, StoreEntry } from "@sous-io/plugin-formats/types";
import type { RecipesStore, StoreGcOptions, StoreGcReport, StoreHit, StoreKey } from "../types.js";

/** The marker file of an entry. */
export const STORE_ENTRY_FILENAME = ".sous.entry.json";

/** The index cache's directory, a sibling of the entries inside the store root. */
export const INDEX_CACHE_DIRNAME = "_indexes";

/** How old a last-access stamp must be before a read refreshes it. */
const ACCESS_GRANULARITY_MS = 24 * 60 * 60 * 1000;

const TEMP_PREFIX = ".sous-tmp-";
const GIT_DIR_NAME = ".git";

/** How deep a listing walk looks for markers; a guard against link loops. */
const MAX_STORE_DEPTH = 12;

/** What the store needs from other plugins, so a test can hand in plain functions. */
export interface StoreDependencies {
    /** The store root. */
    readonly root: string;
    /** The content hash of a directory (`formats.recipe-hash`). */
    hashDirectory(directory: string): Promise<ContentHash>;
    /** Whether two hashes are equal, ignoring case. */
    hashesEqual(left: string, right: string): boolean;
    /** Checks a parsed marker (`formats.store-entry`); throws when it is not one. */
    parseEntry(value: unknown, source: string): StoreEntry;
    /** Writes a marker in its stable form. */
    stringifyEntry(entry: StoreEntry): string;
    /** Creates the store root with its README the first time anything is written (`host.directories`). */
    ensureRoot?(root: string): Promise<unknown>;
    /** The default size cap (`store.maxBytes`). */
    maxBytes?(): number;
    /** The keys `gc` keeps by default: every recipe this project pins. */
    pinned?(): StoreKey[];
    /** Where self-repair notices go (a corrupted entry removed). */
    warn?(message: string): void;
}

/** `<identity>:namespace/name@version`, as messages name an entry. */
export function formatStoreKey(key: StoreKey): string {
    return `${key.identity}:${key.namespace}/${key.name}@${key.version}`;
}

/** The key an entry is filed under, read back from its own marker. */
export function storeKeyOf(entry: StoreEntry): StoreKey {
    return { identity: entry.repo, namespace: entry.namespace, name: entry.name, version: entry.version };
}

/** The directory segments of an identity: `github.com/sous-io/x` → `["github.com", "sous-io", "x"]`. */
export function identitySegments(identity: string): string[] {
    return identity
        .split("/")
        .map((segment) => segment.trim().toLowerCase())
        .filter((segment) => segment.length > 0);
}

function assertSafeSegment(value: string, label: string): void {
    if (value.length === 0 || value === "." || value === ".." || /[/\\\0]/.test(value)) {
        throw new ConfigError(`Invalid store key: the ${label} '${value}' is not a usable directory name.`, {
            details: ["Every part of a store key (the identity's segments, the namespace, the recipe name and the version) must be one usable path segment."],
        });
    }
}

async function removeTree(target: string): Promise<void> {
    await fs.rm(target, { recursive: true, force: true });
}

/**
 * Copies a tree, skipping `.git`, any stale marker and every symbolic link (the content hash skips
 * links too), and returns the bytes copied.
 */
async function copyTree(source: string, destination: string): Promise<number> {
    await fs.mkdir(destination, { recursive: true });

    let bytes = 0;

    for (const entry of await fs.readdir(source, { withFileTypes: true })) {
        if (entry.name === GIT_DIR_NAME || entry.name === STORE_ENTRY_FILENAME || entry.isSymbolicLink()) {
            continue;
        }

        const from = path.join(source, entry.name);
        const to = path.join(destination, entry.name);

        if (entry.isDirectory()) {
            bytes += await copyTree(from, to);
        } else if (entry.isFile()) {
            const stats = await fs.stat(from);

            await fs.copyFile(from, to);
            await fs.chmod(to, stats.mode & 0o777);
            bytes += stats.size;
        }
    }

    return bytes;
}

/** The recipe store. */
export class RecipeStore implements RecipesStore {
    readonly root: string;

    constructor(private readonly deps: StoreDependencies) {
        this.root = path.normalize(path.resolve(deps.root));
    }

    entryDir(key: StoreKey): string {
        const identity = identitySegments(key.identity);

        if (identity.length < 2) {
            throw new ConfigError(`Invalid store key: '${key.identity}' is not a repository identity.`, {
                details: ["An identity is the repository's host followed by its path, as in 'github.com/sous-io/sous-recipes'."],
            });
        }

        for (const segment of identity) {
            assertSafeSegment(segment, "repository identity");
        }

        assertSafeSegment(key.namespace, "namespace");
        assertSafeSegment(key.name, "recipe name");
        assertSafeSegment(key.version, "version");

        return path.join(this.root, ...identity, key.namespace, key.name, key.version);
    }

    async put(key: StoreKey, sourceDir: string, expectedHash?: ContentHash): Promise<StoreEntry> {
        const target = this.entryDir(key);
        const parent = path.dirname(target);

        await this.deps.ensureRoot?.(this.root);
        await fs.mkdir(parent, { recursive: true });

        const staging = path.join(parent, `${TEMP_PREFIX}${key.version}-${randomBytes(6).toString("hex")}`);

        try {
            const sizeBytes = await copyTree(sourceDir, staging);
            const hash = await this.deps.hashDirectory(staging);

            if (expectedHash !== undefined && !this.deps.hashesEqual(hash, expectedHash)) {
                throw new ConfigError(`The content of ${formatStoreKey(key)} does not match the hash it is pinned to.`, {
                    details: [
                        `Expected: ${expectedHash}`,
                        `Actual:   ${hash}`,
                        "Nothing was written to the store. Either the upstream files changed under a published version, or the download was damaged.",
                    ],
                });
            }

            const existing = await this.readMarker(key);

            if (existing !== undefined && !this.deps.hashesEqual(existing.hash, hash)) {
                throw new ConfigError(`The store already holds ${formatStoreKey(key)} with different content.`, {
                    details: [
                        `Stored:   ${existing.hash}`,
                        `Incoming: ${hash}`,
                        "A published version never changes, so sous will not overwrite it. Remove the entry on purpose if the version was really published again.",
                    ],
                });
            }

            const now = new Date().toISOString();
            const entry: StoreEntry = {
                formatVersion: 1,
                repo: key.identity,
                namespace: key.namespace,
                name: key.name,
                version: key.version,
                hash,
                fetchedAt: existing?.fetchedAt ?? now,
                lastAccessAt: now,
                sizeBytes,
            };

            await fs.writeFile(path.join(staging, STORE_ENTRY_FILENAME), this.deps.stringifyEntry(entry), "utf8");
            await this.swapIntoPlace(staging, target);

            return entry;
        } finally {
            await removeTree(staging);
        }
    }

    async get(key: StoreKey): Promise<StoreHit | undefined> {
        const entry = await this.readMarker(key);

        if (entry === undefined) {
            return undefined;
        }

        const dir = this.entryDir(key);
        const fingerprint = await this.statFingerprint(dir);

        // The files are read and hashed only when their names, sizes or modification times differ
        // from the last verified read; an edit inside the store still changes at least one of them.
        if (entry.statFingerprint === undefined || entry.statFingerprint !== fingerprint) {
            const actual = await this.deps.hashDirectory(dir);

            if (!this.deps.hashesEqual(actual, entry.hash)) {
                await this.remove(key);
                this.deps.warn?.(`The cached copy of ${formatStoreKey(key)} did not match its recorded content hash, so it was removed and will be fetched again.`);

                return undefined;
            }
        }

        // The marker is rewritten only to record a new fingerprint, or when the last access is a
        // day old (`gc` orders by day, so a finer stamp would only cost a write on every run).
        const now = new Date();
        const stale = now.getTime() - Date.parse(entry.lastAccessAt) >= ACCESS_GRANULARITY_MS || Number.isNaN(Date.parse(entry.lastAccessAt));

        if (!stale && entry.statFingerprint === fingerprint) {
            return { dir, entry };
        }

        const touched: StoreEntry = { ...entry, statFingerprint: fingerprint, lastAccessAt: stale ? now.toISOString() : entry.lastAccessAt };

        await fs.writeFile(path.join(dir, STORE_ENTRY_FILENAME), this.deps.stringifyEntry(touched), "utf8");

        return { dir, entry: touched };
    }

    /** A digest of the relative path, size and modification time of every file under an entry, the marker excluded. */
    private async statFingerprint(dir: string): Promise<string> {
        const lines: string[] = [];
        const walk = async (current: string, prefix: string): Promise<void> => {
            const children = await fs.readdir(current, { withFileTypes: true });

            await Promise.all(
                children.map(async (child) => {
                    const relative = prefix === "" ? child.name : `${prefix}/${child.name}`;

                    if (child.isDirectory()) {
                        lines.push(`d ${relative}`);
                        await walk(path.join(current, child.name), relative);
                    } else if (!(prefix === "" && child.name === STORE_ENTRY_FILENAME)) {
                        const stats = await fs.lstat(path.join(current, child.name));

                        lines.push(`f ${relative} ${stats.size} ${stats.mtimeMs}`);
                    }
                }),
            );
        };

        await walk(dir, "");

        return createHash("sha1").update(lines.sort().join("\n")).digest("hex");
    }

    async has(key: StoreKey): Promise<boolean> {
        return (await this.readMarker(key)) !== undefined;
    }

    async remove(key: StoreKey): Promise<void> {
        const target = this.entryDir(key);

        await removeTree(target);
        await this.pruneEmptyParents(path.dirname(target));
    }

    async list(): Promise<StoreEntry[]> {
        const entries: StoreEntry[] = [];

        await this.collect(this.root, 0, entries);

        return entries;
    }

    async gc(options: StoreGcOptions = {}): Promise<StoreGcReport> {
        const maxBytes = options.maxBytes ?? this.deps.maxBytes?.() ?? Number.POSITIVE_INFINITY;
        const keep = options.keep ?? this.deps.pinned?.() ?? [];
        const dryRun = options.dryRun === true;
        const entries = await this.list();
        const bytesBefore = entries.reduce((total, entry) => total + entry.sizeBytes, 0);
        const protectedKeys = new Set(keep.map(formatStoreKey));

        // Least recently used first; ties break on the key, so a pass is deterministic.
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
            if (bytesAfter <= maxBytes || protectedKeys.has(formatStoreKey(storeKeyOf(entry)))) {
                kept.push(entry);
                continue;
            }

            if (!dryRun) {
                await this.remove(storeKeyOf(entry));
            }

            evicted.push(entry);
            bytesAfter -= entry.sizeBytes;
        }

        return { evicted, kept, bytesBefore, bytesAfter, dryRun };
    }

    /** Renames a staged entry over its home, moving any old one aside first. */
    private async swapIntoPlace(staging: string, target: string): Promise<void> {
        const displaced = path.join(path.dirname(target), `${TEMP_PREFIX}old-${randomBytes(6).toString("hex")}`);
        let moved = false;

        try {
            await fs.rename(target, displaced);
            moved = true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }

        try {
            await fs.rename(staging, target);
        } catch (error) {
            if (moved) {
                await fs.rename(displaced, target);
            }

            throw error;
        }

        if (moved) {
            await removeTree(displaced);
        }
    }

    /** The marker of an entry; an unreadable one is reported and treated as absent, so the store heals. */
    private async readMarker(key: StoreKey): Promise<StoreEntry | undefined> {
        const file = path.join(this.entryDir(key), STORE_ENTRY_FILENAME);
        const marker = await this.readMarkerFile(file);

        if (marker === "unreadable") {
            this.deps.warn?.(`The store entry marker at ${file} could not be read, so the cached copy of ${formatStoreKey(key)} was ignored. It will be fetched again.`);

            return undefined;
        }

        return marker;
    }

    private async readMarkerFile(file: string): Promise<StoreEntry | "unreadable" | undefined> {
        let raw: string;

        try {
            raw = await fs.readFile(file, "utf8");
        } catch {
            return undefined;
        }

        try {
            return this.deps.parseEntry(JSON.parse(raw), file);
        } catch {
            return "unreadable";
        }
    }

    private async pruneEmptyParents(dir: string): Promise<void> {
        let current = dir;

        while (current.startsWith(this.root + path.sep)) {
            try {
                if ((await fs.readdir(current)).length > 0) {
                    return;
                }

                await fs.rmdir(current);
            } catch {
                return;
            }

            current = path.dirname(current);
        }
    }

    /** Walks the store; any directory holding a readable marker is an entry, and nothing below it is walked. */
    private async collect(dir: string, depth: number, into: StoreEntry[]): Promise<void> {
        if (depth > MAX_STORE_DEPTH) {
            return;
        }

        let children;

        try {
            children = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const child of children) {
            if (!child.isDirectory() || child.name.startsWith(TEMP_PREFIX) || (depth === 0 && child.name === INDEX_CACHE_DIRNAME)) {
                continue;
            }

            const childDir = path.join(dir, child.name);
            const markerFile = path.join(childDir, STORE_ENTRY_FILENAME);
            const marker = await this.readMarkerFile(markerFile);

            if (marker === "unreadable") {
                this.deps.warn?.(`The store entry marker at ${markerFile} could not be read, so that cached copy was left out of the listing.`);
            } else if (marker !== undefined) {
                into.push(marker);
            } else {
                await this.collect(childDir, depth + 1, into);
            }
        }
    }
}
