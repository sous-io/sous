/**
 * The `--env-file` flag of `vars ask`: which of the project's two env files a run writes to.
 */

import path from "node:path";
import { ConfigError } from "@sous-io/plugin-api";
import type { EnvFileKind } from "@sous-io/plugin-config-files/types";
import { ENV_FILE_NAMES } from "./ladder.js";

/** The sentence an unaccepted file is refused with. */
export const ENV_FILE_CHOICES = "The allowed files are .sous/.env (committed, shared with everyone on the project) and .sous/.env.local (gitignored, this machine only).";

/**
 * Settles what `--env-file` names. Accepts `.env`, `.sous/.env`, an absolute path to either, and
 * the same for `.env.local`; anything else is refused.
 *
 * ```ts
 * resolveEnvFile(".env.local", { shared: "/p/.sous/.env", local: "/p/.sous/.env.local" }, "/p");
 * // -> "local"
 * ```
 *
 * @param value - What the flag was given.
 * @param paths - The two env files, as absolute or project-relative paths.
 * @param root - The directory relative paths are read against: the project root.
 */
export function resolveEnvFile(value: string, paths: Readonly<Record<EnvFileKind, string>>, root: string, cwd: string = root): EnvFileKind {
    const wanted = new Set([path.resolve(cwd, value), path.resolve(root, value), path.resolve(root, ".sous", value)]);

    for (const kind of ["shared", "local"] as const) {
        if (wanted.has(path.resolve(root, paths[kind]))) {
            return kind;
        }
    }

    throw new ConfigError(`'${value}' is not an env file sous can write answers to. ${ENV_FILE_CHOICES}`);
}

/** The name an env file is shown under. */
export function envFileName(kind: EnvFileKind): string {
    return `.sous/${ENV_FILE_NAMES[kind]}`;
}
