import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { Environment, ProjectInfo } from "@sous-io/plugin-api";

/** The config file names looked for in `.sous/`, in this order. */
export const CONFIG_FILE_NAMES = [
    "sous.config.ts",
    "sous.config.mts",
    "sous.config.js",
    "sous.config.mjs",
    "sous.config.jsonc",
    "sous.config.json",
    "sous.config.yaml",
    "sous.config.yml",
] as const;

/**
 * Finds the project a sous process serves: the nearest `.sous/` directory at or above `cwd` that
 * holds a config file. The project root is the directory holding it. A `.sous/` without a config
 * file is passed over, as before 1.0: the user-level sous home (`~/.sous`) is one, and it is not a
 * project. Returns `undefined` outside any project.
 *
 * ```ts
 * findProject("/work/app/src");
 * // { root: "/work/app", sousDir: "/work/app/.sous", configPath: "/work/app/.sous/sous.config.jsonc", confDir: "/work/app/.sous/conf.d" }
 * ```
 */
export function findProject(cwd: string, confDir?: string): ProjectInfo | undefined {
    for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
        const sousDir = path.join(dir, ".sous");
        const configPath = isDirectory(sousDir) ? configIn(sousDir) : undefined;

        if (configPath !== undefined) {
            return projectAt(sousDir, configPath, confDir);
        }

        if (path.dirname(dir) === dir) {
            return undefined;
        }
    }
}

/** Where the config is, as the command line and the environment say before any discovery. */
export interface ProjectOverrides {
    /** A config file, or a directory holding one (or holding a `.sous/` that does), and what named it. */
    readonly config?: { readonly value: string; readonly source: string };
    /** A `conf.d` directory to use instead of `<sousDir>/conf.d`. */
    readonly confDir?: string;
}

/**
 * Reads the overrides of project discovery, highest first: `--config`/`-c`/`--sous-config`, then
 * `SOUS_CONFIG`, then `--sous-dir`, then `SOUS_DIR`; and `--sous-confd` before `SOUS_CONFD`. Only
 * the arguments before a bare `--` are read: what follows belongs to a launched tool. Empty values
 * count as unset.
 *
 * ```ts
 * readOverrides(["build", "-c", "alt/sous.config.js"], {}, "/work");
 * // { config: { value: "/work/alt/sous.config.js", source: "-c" } }
 * ```
 */
export function readOverrides(argv: readonly string[], env: Environment, cwd: string): ProjectOverrides {
    const flags = readFlags(argv, ["config", "c", "sous-config", "sous-dir", "sous-confd"]);
    const candidates: Array<[string | undefined, string]> = [
        [flags.config ?? flags.c, flags.c !== undefined && flags.config === undefined ? "-c" : "--config"],
        [flags["sous-config"], "--sous-config"],
        [blank(env.SOUS_CONFIG), "SOUS_CONFIG"],
        [flags["sous-dir"], "--sous-dir"],
        [blank(env.SOUS_DIR), "SOUS_DIR"],
    ];
    const chosen = candidates.find(([value]) => value !== undefined);
    const confd = flags["sous-confd"] ?? blank(env.SOUS_CONFD);

    return {
        config: chosen === undefined ? undefined : { value: resolvePath(chosen[0]!, cwd, env), source: chosen[1] },
        confDir: confd === undefined ? undefined : resolvePath(confd, cwd, env),
    };
}

/**
 * The project the overrides name, or the one found walking up from `cwd` when they name none.
 * Throws an `Error` saying what is wrong when an override points at nothing usable.
 */
export function locateProject(cwd: string, overrides: ProjectOverrides): ProjectInfo | undefined {
    if (overrides.config === undefined) {
        return findProject(cwd, overrides.confDir);
    }

    const { value, source } = overrides.config;

    if (!existsSync(value)) {
        throw new Error(`${source} path not found: ${value}`);
    }

    if (!isDirectory(value)) {
        return projectAt(path.dirname(value), value, overrides.confDir);
    }

    const direct = configIn(value);

    if (direct !== undefined) {
        return projectAt(value, direct, overrides.confDir);
    }

    const nested = path.join(value, ".sous");
    const nestedConfig = isDirectory(nested) ? configIn(nested) : undefined;

    if (nestedConfig !== undefined) {
        return projectAt(nested, nestedConfig, overrides.confDir);
    }

    throw new Error(`${source} points at a directory with no sous config file: ${value}\nLooked for: ${CONFIG_FILE_NAMES.join(", ")}`);
}

function projectAt(sousDir: string, configPath: string, confDir: string | undefined): ProjectInfo {
    return { root: path.dirname(sousDir), sousDir, configPath, confDir: confDir ?? path.join(sousDir, "conf.d") };
}

function configIn(sousDir: string): string | undefined {
    const name = CONFIG_FILE_NAMES.find((candidate) => isFile(path.join(sousDir, candidate)));

    return name === undefined ? undefined : path.join(sousDir, name);
}

/** The values of the named flags (`--name value`, `--name=value`, `-c value`), up to a bare `--`. */
function readFlags(argv: readonly string[], names: readonly string[]): Record<string, string | undefined> {
    const found: Record<string, string | undefined> = {};

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;

        if (arg === "--") {
            break;
        }

        for (const name of names) {
            const flag = name.length === 1 ? `-${name}` : `--${name}`;

            if (found[name] !== undefined) {
                continue;
            }

            if (arg === flag) {
                found[name] = blank(argv[i + 1]);
            } else if (arg.startsWith(`${flag}=`)) {
                found[name] = blank(arg.slice(flag.length + 1));
            }
        }
    }

    return found;
}

function blank(value: string | undefined): string | undefined {
    return value === undefined || value.trim() === "" ? undefined : value;
}

function resolvePath(value: string, cwd: string, env: Environment): string {
    const home = env.HOME;

    if (home !== undefined && (value === "~" || value.startsWith("~/"))) {
        return path.join(home, value.slice(1));
    }

    return path.resolve(cwd, value);
}

function isDirectory(file: string): boolean {
    try {
        return statSync(file).isDirectory();
    } catch {
        return false;
    }
}

function isFile(file: string): boolean {
    try {
        return statSync(file).isFile();
    } catch {
        return false;
    }
}
