/**
 * The core recipe that ships inside the sous package (S6, `recipes.core`).
 *
 * The `core` namespace holds the skills that teach an agent what sous is. Every project gets it,
 * and a project that has never seen a network must still get it, so a copy lives in the package at
 * `recipes/core/sous-skills/` and seeds the machine-wide store.
 *
 * Version parity: the packaged recipe's version is the sous version, and the built-in `core`
 * subscription's range is exactly that version, so core always matches the CLI.
 */

import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import type { IndexFile } from "@sous-io/plugin-formats/types";
import type { RepoEntry, SubscriptionEntry } from "../../types.js";
import {
    BUILT_IN_ADDED_BY,
    CORE_NAMESPACE,
    CORE_RECIPE_KEY,
    CORE_RECIPE_NAME,
    CORE_RECIPE_PATH,
    OFFICIAL_REPO_IDENTITY,
    OFFICIAL_REPO_PROVIDER,
    OFFICIAL_REPO_URL,
    PACKAGED_RECIPES_DIRNAME,
} from "../constants.js";
import type { IndexOverlay } from "../index-cache/index-cache.js";

/** The description the stand-in index gives the core namespace. */
export const CORE_NAMESPACE_DESCRIPTION =
    "Skills that teach an agent about sous itself: what sous manages, how its configuration works, how templates render, and how skills are written. " +
    "Auto-subscribed in every project, with opt-out-only semantics.";

/** The built-in repository entry, exactly as a person could have written it. */
export function builtInRepoEntry(): RepoEntry {
    return { url: OFFICIAL_REPO_URL, provider: OFFICIAL_REPO_PROVIDER, addedBy: BUILT_IN_ADDED_BY };
}

/** The built-in `core` subscription: its range is the exact running version. */
export function builtInCoreSubscription(version: string): SubscriptionEntry {
    return { range: version, addedBy: BUILT_IN_ADDED_BY };
}

/** True when an entry is one sous provided rather than one the project wrote. */
export function isBuiltInEntry(entry: { addedBy?: string } | undefined): boolean {
    return entry?.addedBy === BUILT_IN_ADDED_BY;
}

/**
 * The directory holding the packaged core recipe: `<package root>/recipes/core/sous-skills`. In a
 * development checkout the package root may sit below the repository root that holds `recipes/`,
 * so up to three parents are tried. `undefined` when none holds it.
 */
export function packagedCoreRecipeDir(packageRoot: string): string | undefined {
    let root = path.resolve(packageRoot);

    for (let tries = 0; tries < 4; tries += 1) {
        const candidate = path.join(root, PACKAGED_RECIPES_DIRNAME, CORE_NAMESPACE, CORE_RECIPE_NAME);

        if (fs.existsSync(candidate)) {
            return candidate;
        }

        const parent = path.dirname(root);

        if (parent === root) {
            break;
        }

        root = parent;
    }

    return undefined;
}

/** What the overlay needs to know about the version sous ships. */
export interface CoreIndexOverlayOptions {
    /** The packaged version: the running sous version. */
    version: string;
    /** The packaged copy's hash, or a function working it out on first use. */
    hash: string | (() => string | undefined);
    /** The packaged recipe's description, or a function giving it, asked only when the overlay adds the version. */
    description?: string | (() => string | undefined);
    /** Told once when upstream publishes this version with different contents. */
    onMismatch?: (published: string, packaged: string) => void;
}

/**
 * The overlay that makes the packaged core recipe resolvable whatever the official repository has
 * published so far:
 *
 * - the index publishes this version with this hash: returned untouched;
 * - it publishes this version with another hash: upstream wins, and `onMismatch` is told once;
 * - it does not publish this version: it is added, marked `seeded`.
 */
export function coreIndexOverlay(options: CoreIndexOverlayOptions): IndexOverlay {
    let warned = false;
    const packagedHash = (): string | undefined => (typeof options.hash === "function" ? options.hash() : options.hash);

    return (identity, index) => {
        if (identity !== OFFICIAL_REPO_IDENTITY) {
            return index;
        }

        const hash = packagedHash();

        if (hash === undefined) {
            return index;
        }

        const recipe = index.recipes[CORE_RECIPE_KEY];
        const published = recipe?.versions[options.version];

        if (published !== undefined) {
            if (published.hash !== hash && !warned) {
                warned = true;
                options.onMismatch?.(published.hash, hash);
            }

            return index;
        }

        const description = recipe?.description ?? (typeof options.description === "function" ? options.description() : options.description);

        return {
            ...index,
            namespaces: {
                ...index.namespaces,
                [CORE_NAMESPACE]: index.namespaces[CORE_NAMESPACE] ?? { description: CORE_NAMESPACE_DESCRIPTION },
            },
            recipes: {
                ...index.recipes,
                [CORE_RECIPE_KEY]: {
                    ...recipe,
                    path: recipe?.path ?? CORE_RECIPE_PATH,
                    ...(description === undefined ? {} : { description }),
                    versions: {
                        ...recipe?.versions,
                        [options.version]: {
                            hash: hash as IndexFile["recipes"][string]["versions"][string]["hash"],
                            tag: `${CORE_RECIPE_KEY}@${options.version}`,
                            prerelease: semver.prerelease(options.version) !== null,
                            seeded: true,
                        },
                    },
                },
            },
        };
    };
}
