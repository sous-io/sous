/**
 * The user-level sous directory: where machine-wide, project-independent state
 * lives. Today that is the recipe store, globally linked checkouts and the
 * machine-wide links map; the user-level config LAYER is a separate effort and
 * is deliberately NOT read from here.
 *
 * The location is `~/.sous`, overridable with the `SOUS_HOME` environment
 * variable.
 *
 * IMPORTANT: `SOUS_HOME` is file-settable. Unlike `SOUS_CONFIG`, `SOUS_DIR` and
 * `SOUS_CONFD`, which decide which project is active and therefore must come
 * from the real environment only, `SOUS_HOME` may be set in `.sous/.env.local`
 * or `.sous/.env`. Every function here reads `process.env` at CALL time for
 * exactly that reason; never capture the value at import time, because the env
 * files are loaded after this module is first imported (see `loadEnvFiles` in
 * `base-command.ts`).
 */

import os from "node:os";
import path from "node:path";

/** The directory name used under the user's home directory. */
export const SOUS_HOME_DIR_NAME = ".sous";

/** The environment variable that overrides the user-level sous directory. */
export const SOUS_HOME_ENV_VAR = "SOUS_HOME";

/** Subdirectory of the user-level directory holding the recipe store. */
export const STORE_DIR_NAME = "cache";

/** Subdirectory of the user-level directory holding globally linked checkouts. */
export const GLOBAL_REPOS_DIR_NAME = "repos";

/** File name of the machine-wide links map. */
export const GLOBAL_LINKS_FILENAME = "sous.links.json";

/** A read-only view of an environment, so callers can pass a test fixture. */
export type EnvLike = Record<string, string | undefined>;

/**
 * Expands a leading `~` in a path, so `SOUS_HOME=~/sous-home` behaves the way a
 * user typing it into an env file expects. A bare `~` and `~/...` expand; a
 * `~user/...` form does not (sous has no way to resolve another account's home
 * directory portably) and is left alone.
 *
 * @param value - The raw path, as written by the user.
 */
function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/**
 * Resolves the user-level sous directory: `$SOUS_HOME` when it is set to a
 * non-blank value, otherwise `<home>/.sous`. The result is normalized but is
 * NOT created; each consumer creates the subdirectory it needs.
 *
 * A blank or whitespace-only `SOUS_HOME` is treated as unset rather than as the
 * current directory, matching how `base-command.ts` treats the other `SOUS_*`
 * variables.
 *
 * @param env - The environment to read; defaults to the live `process.env`.
 */
export function resolveSousHome(env: EnvLike = process.env): string {
  const raw = env[SOUS_HOME_ENV_VAR];
  if (typeof raw === "string" && raw.trim().length > 0) {
    return path.normalize(path.resolve(expandHome(raw.trim())));
  }
  return path.join(os.homedir(), SOUS_HOME_DIR_NAME);
}

/**
 * Resolves the root of the machine-wide recipe store, `$SOUS_HOME/cache`.
 *
 * @param env - The environment to read; defaults to the live `process.env`.
 */
export function resolveStoreRoot(env: EnvLike = process.env): string {
  return path.join(resolveSousHome(env), STORE_DIR_NAME);
}

/**
 * Resolves the directory holding globally linked checkouts,
 * `$SOUS_HOME/repos`. A `sous repo link --global` clones into
 * `<this dir>/<owner>/<repo>`.
 *
 * @param env - The environment to read; defaults to the live `process.env`.
 */
export function resolveGlobalReposDir(env: EnvLike = process.env): string {
  return path.join(resolveSousHome(env), GLOBAL_REPOS_DIR_NAME);
}

/**
 * Resolves the machine-wide links map, `$SOUS_HOME/sous.links.json`. A
 * project's own `.sous/sous.links.json` is read alongside it and wins on
 * conflict.
 *
 * @param env - The environment to read; defaults to the live `process.env`.
 */
export function resolveGlobalLinksPath(env: EnvLike = process.env): string {
  return path.join(resolveSousHome(env), GLOBAL_LINKS_FILENAME);
}
