/**
 * The names sous reads config from: the `sous.config.*` file names, and the format each file name
 * means.
 */

import type { ConfigFileFormat } from "./types.js";

/** The base name of the main config file. */
export const MAIN_CONFIG_BASE_NAME = "sous.config";

/**
 * The names `sous.config.*` is found under in a `.sous/` directory, in the order they are tried.
 * The `sous` package's project locator tries the same names in the same order.
 */
export const MAIN_CONFIG_FILE_NAMES = [
    "sous.config.ts",
    "sous.config.mts",
    "sous.config.js",
    "sous.config.mjs",
    "sous.config.jsonc",
    "sous.config.json",
    "sous.config.yaml",
    "sous.config.yml",
] as const;

/** The directory name of the `.sous/` directory. */
export const SOUS_DIR_NAME = ".sous";

/** The drop-in directory inside `.sous/`. */
export const CONFD_DIR_NAME = "conf.d";

/** The committed env file inside `.sous/`: values a whole team shares, never secrets. */
export const ENV_SHARED_NAME = ".env";

/** The gitignored env file inside `.sous/`: values for this machine, secrets among them. */
export const ENV_LOCAL_NAME = ".env.local";

/** File name endings and the format each means. Longer endings come first, so `.patch.json` wins over `.json`. */
const ENDINGS: ReadonlyArray<readonly [string, ConfigFileFormat]> = [
    [".patch.jsonl", "patch-jsonl"],
    [".patch.json", "patch-json"],
    [".jsonc", "jsonc"],
    [".json", "json"],
    [".yaml", "yaml"],
    [".yml", "yaml"],
    [".mjs", "js"],
    [".cjs", "js"],
    [".js", "js"],
    [".mts", "ts"],
    [".cts", "ts"],
    [".ts", "ts"],
];

/**
 * The format a file name means, or `undefined` for a file sous does not read. Names starting with
 * a dot (`.env`, editor swap files) are never config files.
 *
 * ```ts
 * formatOf("610-mac.jsonc");            // "jsonc"
 * formatOf("720-x.patch.json");         // "patch-json"
 * formatOf("README.md");                // undefined
 * ```
 */
export function formatOf(fileName: string): ConfigFileFormat | undefined {
    if (fileName.startsWith(".")) {
        return undefined;
    }

    const lower = fileName.toLowerCase();

    for (const [ending, format] of ENDINGS) {
        if (lower.endsWith(ending) && lower.length > ending.length) {
            return format;
        }
    }

    return undefined;
}

/**
 * A file name without its final extension: `500-repos.jsonc` → `500-repos`. Two files with the
 * same base name merge in an order that depends on their extensions, which sous warns about.
 */
export function baseNameOf(fileName: string): string {
    const dot = fileName.lastIndexOf(".");

    return dot <= 0 ? fileName : fileName.slice(0, dot);
}
