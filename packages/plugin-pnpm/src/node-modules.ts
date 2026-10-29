/**
 * Reading a `node_modules` directory: what a package manager reports as installed. The same small
 * module is in plugin-npm, plugin-pnpm and plugin-yarn, since plugins may not import each other.
 */

import fs from "node:fs";
import path from "node:path";
import type { DependencySection, InstalledPackage } from "@sous-io/plugin-update/types";

/** The keyword that marks a package as a sous plugin. */
export const PLUGIN_KEYWORD = "sous-plugin";

/** A parsed `package.json`. */
export type PackageJson = Record<string, unknown>;

/** Reads and parses a `package.json` in a directory; `undefined` when missing or broken. */
export function readPackageJson(dir: string): PackageJson | undefined {
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));

        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as PackageJson) : undefined;
    } catch {
        return undefined;
    }
}

/** The real path of a path, or the path itself when it cannot be resolved. */
export function realpathOr(target: string): string {
    try {
        return fs.realpathSync(target);
    } catch {
        return target;
    }
}

/** The nearest directory at or above `start` that `test` accepts, or `undefined`. */
export function findUp(start: string, test: (dir: string) => boolean): string | undefined {
    let dir = path.resolve(start);

    for (;;) {
        if (test(dir)) return dir;
        const parent = path.dirname(dir);

        if (parent === dir) return undefined;
        dir = parent;
    }
}

/** How a `package.json` declares a package: `devDependencies` first, then `dependencies`. */
export function declaredIn(
    pkg: PackageJson | undefined,
    name: string,
): { section: DependencySection; range: string } | undefined {
    if (pkg === undefined) return undefined;

    for (const section of ["devDependencies", "dependencies"] as const) {
        const block = pkg[section];
        const range = block !== null && typeof block === "object" ? (block as Record<string, unknown>)[name] : undefined;

        if (typeof range === "string") return { section, range };
    }

    return undefined;
}

/** Whether a `package.json` declares itself a sous plugin. */
export function isSousPlugin(pkg: PackageJson): boolean {
    return Array.isArray(pkg.keywords) && pkg.keywords.includes(PLUGIN_KEYWORD);
}

/** The package names in a `node_modules` directory, scopes unfolded; dot-directories are skipped. */
function packageNames(modules: string): string[] {
    let entries: fs.Dirent[];

    try {
        entries = fs.readdirSync(modules, { withFileTypes: true });
    } catch {
        return [];
    }

    const names: string[] = [];

    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (entry.name.startsWith(".")) continue;

        if (entry.name.startsWith("@")) {
            try {
                for (const inner of fs.readdirSync(path.join(modules, entry.name)).sort()) {
                    if (!inner.startsWith(".")) names.push(`${entry.name}/${inner}`);
                }
            } catch {
                // An unreadable scope has nothing to list.
            }
        } else {
            names.push(entry.name);
        }
    }

    return names;
}

/**
 * The packages in a `node_modules` directory. `declaring` is the `package.json` of the project
 * whose dependencies they are; with it, each package says where it was declared. A directory whose
 * `package.json` is missing is left out.
 */
export function readInstalled(modules: string, declaring?: PackageJson): InstalledPackage[] {
    const installed: InstalledPackage[] = [];

    for (const name of packageNames(modules)) {
        const location = path.join(modules, ...name.split("/"));
        const pkg = readPackageJson(location);

        if (pkg === undefined) continue;
        const declared = declaredIn(declaring, name);

        installed.push({
            name,
            version: typeof pkg.version === "string" ? pkg.version : "unknown",
            location,
            realPath: realpathOr(location),
            isSousPlugin: isSousPlugin(pkg),
            ...(declared === undefined ? {} : { declared }),
        });
    }

    return installed;
}

/** The `version` of a `packageManager` field (`pnpm@9.1.0+sha`) for one manager, or `undefined`. */
export function packageManagerField(pkg: PackageJson | undefined, manager: string): string | undefined {
    const field = pkg?.packageManager;

    if (typeof field !== "string") return undefined;
    const match = /^([^@]+)@([^+]+)/.exec(field);

    return match !== null && match[1] === manager ? match[2] : undefined;
}

/** The manager a `packageManager` field names, or `undefined`. */
export function packageManagerName(pkg: PackageJson | undefined): string | undefined {
    const field = pkg?.packageManager;

    return typeof field === "string" ? /^([^@]+)@/.exec(field)?.[1] : undefined;
}

/** Lockfiles and files of the managers sous does not drive, which say the project is not npm's. */
export const OTHER_MANAGER_FILES = ["yarn.lock", ".yarnrc.yml", ".pnp.cjs", "pnpm-lock.yaml", "pnpm-workspace.yaml", "bun.lock", "bun.lockb", "deno.lock"];

/** The last non-empty line of a command's output. */
export function lastLine(output: string): string | undefined {
    const line = output.trim().split(/\r?\n/).pop()?.trim();

    return line === undefined || line.length === 0 ? undefined : line;
}
