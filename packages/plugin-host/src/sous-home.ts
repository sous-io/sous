/**
 * `host.sous-home`: where machine-wide, project-independent data lives. `SOUS_HOME` is settable
 * from the env files, so the environment is read at call time, never captured.
 */

import os from "node:os";
import path from "node:path";
import type { Environment } from "@sous-io/plugin-api";
import type { HostSousHome, SousHomePaths } from "./types.js";

/** The directory name used under the user's home directory. */
export const SOUS_HOME_DIR_NAME = ".sous";

/** The environment variable that overrides the sous home. */
export const SOUS_HOME_ENV_VAR = "SOUS_HOME";

/** Directory of the recipe store, under the root. */
export const STORE_DIR_NAME = "cache";

/** Directory of cached repository indexes, under the store. */
export const INDEX_CACHE_DIR_NAME = "_indexes";

/** Directory of machine-wide repository checkouts, under the root. */
export const GLOBAL_REPOS_DIR_NAME = "repos";

/** File name of the machine-wide links map. */
export const GLOBAL_LINKS_FILENAME = "sous.links.json";

/** File name of the read-strategy record, under the store. */
export const READ_STRATEGIES_FILENAME = "read-strategies.json";

/** Expands a leading `~` (`~` and `~/...`); `~user/...` is left alone. */
function expandHome(value: string): string {
    if (value === "~") {
        return os.homedir();
    }

    if (value.startsWith("~/") || value.startsWith("~\\")) {
        return path.join(os.homedir(), value.slice(2));
    }

    return value;
}

/**
 * The sous home of an environment: `$SOUS_HOME` when it is not blank, else `~/.sous`. A blank value
 * counts as unset, never as the current directory.
 */
export function resolveSousHomePaths(env: Environment): SousHomePaths {
    const raw = env[SOUS_HOME_ENV_VAR];
    const root =
        typeof raw === "string" && raw.trim().length > 0
            ? path.normalize(path.resolve(expandHome(raw.trim())))
            : path.join(os.homedir(), SOUS_HOME_DIR_NAME);
    const store = path.join(root, STORE_DIR_NAME);

    return {
        root,
        store,
        indexCache: path.join(store, INDEX_CACHE_DIR_NAME),
        repos: path.join(root, GLOBAL_REPOS_DIR_NAME),
        links: path.join(root, GLOBAL_LINKS_FILENAME),
        readStrategies: path.join(store, READ_STRATEGIES_FILENAME),
    };
}

/** Makes the `host.sous-home` service; `getEnv` is read on every call. */
export function createSousHome(getEnv: () => Environment): HostSousHome {
    return {
        paths: (env) => resolveSousHomePaths(env ?? getEnv()),
        resolve: (...segments) => path.join(resolveSousHomePaths(getEnv()).root, ...segments),
    };
}
