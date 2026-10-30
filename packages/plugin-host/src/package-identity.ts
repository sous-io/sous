/** `host.package`: where the installed sous is, and its version. */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PluginError } from "@sous-io/plugin-api";
import type { HostPackage, PackageIdentity } from "./types.js";

/** The package names the installed sous may have. */
export const SOUS_PACKAGE_NAMES: readonly string[] = ["@sous-io/sous"];

/** Where to look. */
export interface PackageIdentityOptions {
    /** The directory to start looking upward from. Default: this module's own directory. */
    startDir?: string;
    /** The script sous was started through. Default: `process.argv[1]`. */
    bin?: string | undefined;
    /** The package names that count as sous. */
    names?: readonly string[];
}

/** Reads a package.json, or `undefined` when it is missing or broken. */
function readPackage(file: string): { name?: string; version?: string } | undefined {
    try {
        return JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
    } catch {
        return undefined;
    }
}

/** The nearest directory upward from `from` that holds a package.json named like sous. */
function findRoot(from: string, names: readonly string[]): { root: string; version: string } | undefined {
    let current = path.resolve(from);

    for (;;) {
        const manifest = readPackage(path.join(current, "package.json"));

        if (manifest?.name !== undefined && names.includes(manifest.name)) {
            return { root: current, version: manifest.version ?? "0.0.0" };
        }

        const parent = path.dirname(current);

        if (parent === current) {
            return undefined;
        }

        current = parent;
    }
}

/** Makes the `host.package` service. The package is found once and kept. */
export function createPackage(options: PackageIdentityOptions = {}): HostPackage {
    let identity: PackageIdentity | undefined;

    return {
        identity() {
            if (identity !== undefined) {
                return identity;
            }

            const names = options.names ?? SOUS_PACKAGE_NAMES;
            const bin = "bin" in options ? options.bin : process.argv[1];
            const startDir = options.startDir ?? path.dirname(fileURLToPath(import.meta.url));
            const starts = [startDir];

            if (bin !== undefined && existsSync(bin)) {
                starts.push(path.dirname(realpathSync(bin)));
            }

            for (const start of starts) {
                const found = findRoot(start, names);

                if (found !== undefined) {
                    const manifest = readPackage(path.join(found.root, "package.json"));

                    identity = {
                        name: manifest?.name ?? names[0]!,
                        version: found.version,
                        root: found.root,
                        realRoot: realpathSync(found.root),
                        bin,
                    };

                    return identity;
                }
            }

            throw new PluginError("@sous-io/plugin-host", `Could not find the installed sous: no package.json named ${names.join(" or ")} above ${startDir}.`);
        },
    };
}
