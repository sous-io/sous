import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { ProjectInfo } from "@sous-io/plugin-api";

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
 * Finds the project a sous process serves (S1; S6, `ProjectLocator`): the nearest `.sous/` directory
 * at or above `cwd`. The project root is the directory holding it. Returns `undefined` outside any
 * project.
 *
 * ```ts
 * findProject("/work/app/src");
 * // { root: "/work/app", sousDir: "/work/app/.sous", configPath: "/work/app/.sous/sous.config.jsonc", confDir: "/work/app/.sous/conf.d" }
 * ```
 */
export function findProject(cwd: string): ProjectInfo | undefined {
    for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
        const sousDir = path.join(dir, ".sous");

        if (isDirectory(sousDir)) {
            const configName = CONFIG_FILE_NAMES.find((name) => existsSync(path.join(sousDir, name)));

            return {
                root: dir,
                sousDir,
                configPath: configName ? path.join(sousDir, configName) : undefined,
                confDir: path.join(sousDir, "conf.d"),
            };
        }

        if (path.dirname(dir) === dir) {
            return undefined;
        }
    }
}

function isDirectory(file: string): boolean {
    try {
        return statSync(file).isDirectory();
    } catch {
        return false;
    }
}
