/**
 * A quick answer to "is the store's copy of the core recipe still the one sous checked?", so a run
 * that changes nothing (every `sous --help`) does not hash the copy again.
 *
 * After a full check (the store hashes the copy against its marker), sous records the copy's
 * hash and a fingerprint of its files (each path, size and modification time) in
 * `<store>/.sous-core-seed.json`. On the next run, when the marker still records that hash and
 * the files still have that fingerprint, the copy is taken as checked. Anything else, including a
 * missing or unreadable stamp, falls back to the full check, which heals a damaged copy.
 *
 * ```jsonc
 * // <store>/.sous-core-seed.json
 * {
 *     "formatVersion": 1,
 *     "key": "github.com/sous-io/sous-recipes:core/sous-skills@1.2.0",
 *     "hash": "sha256-...",
 *     "fingerprint": "5c0e..."
 * }
 * ```
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StoreEntry } from "@sous-io/plugin-formats/types";
import type { StoreKey } from "../../types.js";
import { STORE_ENTRY_FILENAME } from "../../part-a/store.js";

/** The stamp's file name, directly inside the store's root. */
export const SEED_STAMP_FILENAME = ".sous-core-seed.json";

/** Remembers the last full check of one store entry. */
export interface SeedStamp {
    /** The entry, when its marker and files are exactly as they were at the last full check; else `undefined`. */
    read(key: StoreKey): StoreEntry | undefined;
    /** Records a full check of the entry. Never throws: a stamp that cannot be written only costs speed. */
    write(key: StoreKey, entry: StoreEntry): void;
}

/** What a stamp needs. */
export interface SeedStampOptions {
    /** The store's root directory. */
    readonly storeRoot: string;
    /** The directory of a store entry. */
    readonly entryDir: (key: StoreKey) => string;
}

interface StampFile {
    readonly formatVersion: 1;
    readonly key: string;
    readonly hash: string;
    readonly fingerprint: string;
}

/** A stamp kept in `<store>/.sous-core-seed.json`. */
export function createSeedStamp(options: SeedStampOptions): SeedStamp {
    const file = path.join(options.storeRoot, SEED_STAMP_FILENAME);

    return {
        read(key) {
            try {
                const stamp = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StampFile>;

                if (stamp.formatVersion !== 1 || stamp.key !== keyLabel(key)) {
                    return undefined;
                }

                const dir = options.entryDir(key);
                const markerFile = path.join(dir, STORE_ENTRY_FILENAME);
                // Read as plain JSON: only its hash is compared, and the store checks the whole
                // marker whenever it hands the entry out.
                const entry = JSON.parse(fs.readFileSync(markerFile, "utf8")) as StoreEntry;

                if (typeof entry?.hash !== "string" || entry.hash !== stamp.hash || fingerprintOf(dir) !== stamp.fingerprint) {
                    return undefined;
                }

                return entry;
            } catch {
                return undefined;
            }
        },

        write(key, entry) {
            try {
                const stamp: StampFile = { formatVersion: 1, key: keyLabel(key), hash: entry.hash, fingerprint: fingerprintOf(options.entryDir(key)) };

                fs.writeFileSync(file, `${JSON.stringify(stamp, null, 4)}\n`, "utf8");
            } catch {
                // Only speed is lost: the next run checks the copy in full again.
            }
        },
    };
}

/** `identity:namespace/name@version`. */
function keyLabel(key: StoreKey): string {
    return `${key.identity}:${key.namespace}/${key.name}@${key.version}`;
}

/**
 * A digest of every file under `dir` but the entry's own marker (which records when the entry was
 * last read, so it changes without the content changing): each relative path, size and
 * modification time. Reading these takes a fraction of the time reading every file would.
 */
export function fingerprintOf(dir: string): string {
    const lines: string[] = [];
    const walk = (current: string, relative: string): void => {
        for (const child of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
            const childRelative = relative === "" ? child.name : `${relative}/${child.name}`;
            const childPath = path.join(current, child.name);

            if (child.isDirectory()) {
                walk(childPath, childRelative);
            } else if (childRelative !== STORE_ENTRY_FILENAME) {
                const stat = fs.lstatSync(childPath);

                lines.push(`${childRelative}\0${stat.size}\0${stat.mtimeMs}`);
            }
        }
    };

    walk(dir, "");

    return createHash("sha256").update(lines.join("\n")).digest("hex");
}
