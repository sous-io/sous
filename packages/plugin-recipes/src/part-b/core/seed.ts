/**
 * Seeding the store with the core recipe that ships inside the package, so a project builds with
 * no network at all, the very first time sous runs on a machine.
 *
 * - Idempotent: when the store already holds this version, nothing is copied or written.
 * - Offline: nothing here touches the network, and nothing here fails a build; a problem comes
 *   back as `skippedBecause`.
 * - Replaceable: the stand-in index is written only when no real index is cached. It carries a
 *   note saying sous wrote it, and no sidecar, so the first run with a network replaces it.
 */

import fs from "node:fs";
import semver from "semver";
import type { IndexFile, StoreEntry } from "@sous-io/plugin-formats/types";
import type { RecipesStore, StoreKey } from "../../types.js";
import { CORE_NAMESPACE, CORE_RECIPE_KEY, CORE_RECIPE_NAME, CORE_RECIPE_PATH, OFFICIAL_REPO_IDENTITY, OFFICIAL_REPO_NAME } from "../constants.js";
import type { IndexCacheCore } from "../index-cache/index-cache.js";
import { messageOf } from "../support.js";
import { CORE_NAMESPACE_DESCRIPTION, coreIndexOverlay } from "./core-recipe.js";
import type { SeedStamp } from "./seed-stamp.js";

/** The note the stand-in index carries in `$comment`, by which sous recognizes its own placeholder. */
export const SEED_INDEX_COMMENT =
    "Written by sous itself from the core recipe inside the installed package, so a project can build before it has ever reached the network. " +
    "The first successful fetch of the real index replaces this file.";

/** What seeding is given. */
export interface SeedOptions {
    readonly store: RecipesStore;
    readonly cache: IndexCacheCore;
    /** The running sous version. */
    readonly version: string;
    /** The packaged recipe's directory, or `undefined` when the package lacks it. */
    readonly packagedDir: string | undefined;
    /** The packaged recipe's description, for the stand-in index; a function is asked only when one is needed. */
    readonly description?: string | (() => string | undefined);
    /** Remembers the last full check of the stored copy, so an unchanged copy is not hashed again. */
    readonly stamp?: SeedStamp;
    readonly now?: () => Date;
    /** Told once when upstream publishes this version with other contents. */
    readonly onMismatch?: (published: string, packaged: string) => void;
}

/** What seeding did. */
export interface SeedReport {
    readonly seeded: boolean;
    readonly alreadyPresent: boolean;
    readonly wroteIndex: boolean;
    readonly version: string;
    readonly hash?: string;
    /** Why nothing was seeded: one sentence, shown as a warning. */
    readonly skippedBecause?: string;
}

/** Copies the packaged core recipe into the store, teaches the cache its hash, and writes a stand-in index when nothing real is cached. */
export async function seedCoreRecipe(options: SeedOptions): Promise<SeedReport> {
    const { version } = options;
    const key: StoreKey = { identity: OFFICIAL_REPO_IDENTITY, namespace: CORE_NAMESPACE, name: CORE_RECIPE_NAME, version };

    if (options.packagedDir === undefined) {
        return {
            seeded: false,
            alreadyPresent: false,
            wroteIndex: false,
            version,
            skippedBecause: "This installation of sous is missing the core recipe it ships with, so the skills in the 'core' namespace are unavailable. Reinstalling sous restores it.",
        };
    }

    try {
        let entry = options.stamp?.read(key);
        let seeded = false;

        if (entry === undefined) {
            // The full check: the store hashes its copy and drops a damaged one.
            const existing = await options.store.get(key);

            if (existing === undefined) {
                entry = await options.store.put(key, options.packagedDir);
                seeded = true;
            } else {
                entry = existing.entry;
            }

            options.stamp?.write(key, entry);
        }

        const description = lazyDescription(options.description);

        options.cache.setOverlay(
            coreIndexOverlay({
                version,
                hash: entry.hash,
                description,
                ...(options.onMismatch === undefined ? {} : { onMismatch: options.onMismatch }),
            }),
        );

        const wroteIndex = writeSeedIndex(options.cache, version, entry.hash, (options.now ?? (() => new Date()))(), description);

        return { seeded, alreadyPresent: !seeded, wroteIndex, version, hash: entry.hash };
    } catch (error) {
        return {
            seeded: false,
            alreadyPresent: false,
            wroteIndex: false,
            version,
            skippedBecause: `Sous could not seed the core recipe it ships with, so the skills in the 'core' namespace are unavailable until this is fixed. ${messageOf(error)}`,
        };
    }
}

/** Whether the file is sous's own stand-in index, and offers `version`. Read as plain JSON, unchecked. */
function isSeedIndexFor(file: string, version: string): boolean {
    try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { $comment?: unknown; recipes?: Record<string, { versions?: Record<string, unknown> }> };

        return raw.$comment === SEED_INDEX_COMMENT && raw.recipes?.[CORE_RECIPE_KEY]?.versions?.[version] !== undefined;
    } catch {
        return false;
    }
}

/** The description as a function asked at most once. */
function lazyDescription(description: SeedOptions["description"]): () => string | undefined {
    if (typeof description !== "function") {
        return () => description;
    }

    let asked = false;
    let answer: string | undefined;

    return () => {
        if (!asked) {
            asked = true;
            answer = description();
        }

        return answer;
    };
}

/** Writes the stand-in index, unless the cache holds one a repository published. True when written. */
function writeSeedIndex(cache: IndexCacheCore, version: string, hash: StoreEntry["hash"], now: Date, describe: () => string | undefined): boolean {
    // sous's own stand-in for this version, already in place: nothing to do, and no need to check it
    // in full, which is most of what this costs on a run that changes nothing.
    if (isSeedIndexFor(cache.indexPath(OFFICIAL_REPO_IDENTITY), version)) {
        return false;
    }

    // Nothing cached (or a copy that no longer parses), or sous's own stand-in for another version: write.
    const existing = cache.readRaw(OFFICIAL_REPO_IDENTITY);

    if (existing !== undefined && !(existing.$comment === SEED_INDEX_COMMENT && existing.recipes[CORE_RECIPE_KEY]?.versions[version] === undefined)) {
        return false;
    }

    const timestamp = now.toISOString();
    const description = describe();
    const index: IndexFile = {
        $comment: SEED_INDEX_COMMENT,
        formatVersion: 1,
        name: OFFICIAL_REPO_NAME,
        generatedAt: timestamp,
        generator: version,
        namespaces: { [CORE_NAMESPACE]: { description: CORE_NAMESPACE_DESCRIPTION } },
        recipes: {
            [CORE_RECIPE_KEY]: {
                path: CORE_RECIPE_PATH,
                ...(description === undefined ? {} : { description }),
                versions: {
                    [version]: {
                        hash,
                        tag: `${CORE_RECIPE_KEY}@${version}`,
                        prerelease: semver.prerelease(version) !== null,
                        releasedAt: timestamp,
                        seeded: true,
                    },
                },
            },
        },
    };

    cache.writeIndex(OFFICIAL_REPO_IDENTITY, index);
    // No sidecar: this copy was never fetched, so the next run with a network replaces it at once.
    fs.rmSync(cache.sidecarPath(OFFICIAL_REPO_IDENTITY), { force: true });

    return true;
}
