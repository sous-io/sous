/**
 * Layering the env files over an environment. Precedence, highest first:
 *
 *   the environment sous was started with  >  `.sous/.env.local`  >  `.sous/.env`
 *
 * No load overwrites a value already set, so the first writer of a key wins: `.env.local` loads
 * first, then `.env` fills in only the keys nobody else supplied.
 */

import fs from "node:fs";
import path from "node:path";
import type { Environment, ProjectInfo } from "@sous-io/plugin-api";
import { ENV_LOCAL_NAME, ENV_SHARED_NAME } from "../names.js";
import { parseEnv } from "./env-file.js";

/** A mutable environment the loaders fill in. */
export type MutableEnvironment = Record<string, string | undefined>;

/** What loading one env file did. */
export interface EnvFileLoadResult {
    /** The path checked. */
    filePath: string;
    /** True when the file existed and was read. */
    loaded: boolean;
    /** Names set from the file. */
    applied: string[];
    /** Names in the file that were already set, and left alone. */
    skipped: string[];
}

/** What loading both env files did. */
export interface EnvFilesLoadResult {
    /** `.sous/.env.local`, loaded first, so it wins. */
    local: EnvFileLoadResult;
    /** `.sous/.env`, loaded second. */
    defaults: EnvFileLoadResult;
}

/** Loads one env file into `env`, never overwriting a value already set. */
export function loadEnvFile(filePath: string, env: MutableEnvironment): EnvFileLoadResult {
    if (!fs.existsSync(filePath)) {
        return { filePath, loaded: false, applied: [], skipped: [] };
    }

    const applied: string[] = [];
    const skipped: string[] = [];

    for (const [key, value] of Object.entries(parseEnv(fs.readFileSync(filePath, "utf8")))) {
        if (env[key] !== undefined) {
            skipped.push(key);
            continue;
        }

        env[key] = value;
        applied.push(key);
    }

    return { filePath, loaded: true, applied, skipped };
}

/** Loads `<sousDir>/.env` (committed, shared values) into `env`. */
export function loadEnvDefaults(sousDir: string, env: MutableEnvironment): EnvFileLoadResult {
    return loadEnvFile(path.join(sousDir, ENV_SHARED_NAME), env);
}

/** Loads `<sousDir>/.env.local` (this machine's values and secrets) into `env`. */
export function loadEnvLocal(sousDir: string, env: MutableEnvironment): EnvFileLoadResult {
    return loadEnvFile(path.join(sousDir, ENV_LOCAL_NAME), env);
}

/** Loads both env files into `env`: `.env.local` first, then `.env`. */
export function loadEnvFiles(sousDir: string, env: MutableEnvironment): EnvFilesLoadResult {
    const local = loadEnvLocal(sousDir, env);
    const defaults = loadEnvDefaults(sousDir, env);

    return { local, defaults };
}

/**
 * The environment a project's sous runs with: the given environment, with the project's env files
 * filling in what it does not set. Returns a new object; nothing is changed. Outside a project it
 * is a copy of the environment.
 *
 * The engine's environment (`ctx.env`) is fixed when the engine starts, so the bin calls this on
 * `process.env` before starting it.
 *
 * ```ts
 * const env = projectEnvironment(findProject(cwd), process.env);
 * createEngine({ project, env, ... });
 * ```
 */
export function projectEnvironment(project: Pick<ProjectInfo, "sousDir"> | undefined, env: Environment): Environment {
    const result: MutableEnvironment = { ...env };

    if (project !== undefined) {
        loadEnvFiles(project.sousDir, result);
    }

    return Object.freeze(result);
}
