/**
 * Downloading one pinned recipe into the store: exactly the locked version, at its tag, checked
 * against the locked hash. Nothing here decides a version or asks a question, which is what makes
 * a fresh clone reproducible.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "@sous-io/plugin-api";
import type { LockedRecipe, StoreEntry } from "@sous-io/plugin-formats/types";
import type { RecipesStore, RepositoryHostEntity, StoreKey, RepositoryHostContext } from "../../types.js";
import type { IndexCacheCore } from "../index-cache/index-cache.js";
import { CORE_NAMESPACE, CORE_RECIPE_NAME, OFFICIAL_REPO_IDENTITY } from "../constants.js";
import { hostFor, splitStoredKey } from "../support.js";

/** One pinned recipe to download. */
export interface RestoreTarget {
    readonly key: string;
    readonly entry: LockedRecipe;
    /** The project's short name for the repository. */
    readonly repo: string;
    readonly url: string;
    readonly identity: string;
    readonly provider?: string;
}

/** What downloading needs. */
export interface RestoreDeps {
    readonly store: RecipesStore;
    readonly cache: IndexCacheCore;
    readonly hosts: readonly RepositoryHostEntity[];
    readonly context: RepositoryHostContext;
    /** `store.freshnessSeconds`. */
    readonly freshnessSeconds?: number;
}

/** The store key of a pinned recipe. */
export function storeKeyOf(key: string, identity: string, version: string): StoreKey {
    const { namespace, name } = splitStoredKey(key);

    return { identity, namespace, name, version };
}

/**
 * The store entry of a pinned recipe: the one already there when its hash matches, else a fresh
 * download. Returns the entry and whether it was downloaded.
 */
export async function ensureInStore(target: RestoreTarget, deps: RestoreDeps): Promise<{ entry: StoreEntry; dir: string; downloaded: boolean }> {
    const storeKey = storeKeyOf(target.key, target.identity, target.entry.version);
    const hit = await deps.store.get(storeKey);

    if (hit !== undefined && hit.entry.hash.toLowerCase() === target.entry.hash.toLowerCase()) {
        return { entry: hit.entry, dir: hit.dir, downloaded: false };
    }

    const entry = await download(target, storeKey, deps);

    return { entry, dir: deps.store.entryDir(storeKey), downloaded: true };
}

/** Fetches the recipe's subtree at its tag and puts it in the store under the locked hash. */
async function download(target: RestoreTarget, storeKey: StoreKey, deps: RestoreDeps): Promise<StoreEntry> {
    const indexTarget = { name: target.repo, url: target.url, identity: target.identity, ...(target.provider === undefined ? {} : { provider: target.provider }) };
    const signal = deps.context.signal;
    let lookup = await deps.cache.get(indexTarget, { freshnessSeconds: deps.freshnessSeconds, hosts: deps.hosts, ...(signal ? { signal } : {}) });
    let recipe = lookup.index.recipes[target.key];
    let version = recipe?.versions[target.entry.version];

    if (version === undefined && lookup.source === "cache") {
        // The cached index may predate the release; look upstream once.
        lookup = await deps.cache.get(indexTarget, { latest: true, hosts: deps.hosts, ...(signal ? { signal } : {}) });
        recipe = lookup.index.recipes[target.key];
        version = recipe?.versions[target.entry.version];
    }

    if (recipe === undefined || version === undefined) {
        throw new ConfigError(`The lockfile pins '${target.key}' at version ${target.entry.version} from '${target.repo}', and that repository's index does not offer it.`, {
            details: ["Either the index could not be fetched, or the version was withdrawn upstream. Run 'sous repo list' to see what sous has."],
        });
    }

    const host = hostFor(deps.hosts, target.url, target.provider);

    if (host === undefined) {
        throw new ConfigError(`No repository host reads '${target.url}', so '${target.key}' cannot be downloaded.`);
    }

    await fs.mkdir(deps.store.root, { recursive: true });
    const work = await fs.mkdtemp(path.join(deps.store.root, ".sous-restore-"));
    const fetchDir = path.join(work, storeKey.name || "recipe");

    try {
        await host.fetchRecipeTree(host.canonicalize(target.url), recipe.path, version.tag, fetchDir, deps.context);
        await dropSeededCoreCopy(storeKey, target.entry.hash, deps.store);

        return await deps.store.put(storeKey, fetchDir, target.entry.hash);
    } finally {
        await fs.rm(work, { recursive: true, force: true });
    }
}

/**
 * Removes the store's copy of the core recipe when the lockfile pins other contents for the same
 * version. That copy was seeded from the package; when the official repository publishes this
 * version with other contents, the published one wins, and the store would otherwise refuse it as
 * a changed published version. Only the core recipe is treated this way: any other stored version
 * came from a download and stays immutable.
 */
async function dropSeededCoreCopy(storeKey: StoreKey, pinnedHash: string, store: RecipesStore): Promise<void> {
    if (storeKey.identity !== OFFICIAL_REPO_IDENTITY || storeKey.namespace !== CORE_NAMESPACE || storeKey.name !== CORE_RECIPE_NAME) {
        return;
    }

    const hit = await store.get(storeKey);

    if (hit !== undefined && hit.entry.hash.toLowerCase() !== pinnedHash.toLowerCase()) {
        await store.remove(storeKey);
    }
}
