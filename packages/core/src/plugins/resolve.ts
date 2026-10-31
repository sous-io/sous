import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Node's own lookup of a plugin specifier, from a directory: a path (relative to that directory) or
 * a package name found in `node_modules` above it. Returns a URL to import, or `undefined`.
 */
export function locateWithNode(specifier: string, fromDir: string): string | undefined {
    if (specifier.startsWith("file:")) {
        return specifier;
    }

    if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
        const file = path.resolve(fromDir, specifier);

        return existsSync(file) ? pathToFileURL(file).href : undefined;
    }

    try {
        return pathToFileURL(createRequire(path.join(fromDir, "noop.js")).resolve(specifier)).href;
    } catch {
        return locateEsmPackage(specifier, fromDir);
    }
}

/**
 * Finds an ES-module-only package (one whose `exports` offer only `import`), which `require.resolve`
 * cannot see.
 */
function locateEsmPackage(specifier: string, fromDir: string): string | undefined {
    const parts = specifier.split("/");
    const packageName = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
    const subpath = specifier.slice(packageName.length);

    for (let dir = path.resolve(fromDir); ; dir = path.dirname(dir)) {
        const packageDir = path.join(dir, "node_modules", packageName);
        const manifestPath = path.join(packageDir, "package.json");

        if (existsSync(manifestPath)) {
            const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
                exports?: unknown;
                module?: string;
                main?: string;
            };
            const entry = exportTarget(manifest.exports, `.${subpath}`) ?? (subpath === "" ? (manifest.module ?? manifest.main ?? "index.js") : subpath.slice(1));

            return pathToFileURL(path.join(packageDir, entry)).href;
        }

        if (path.dirname(dir) === dir) {
            return undefined;
        }
    }
}

function exportTarget(exports: unknown, subpath: string): string | undefined {
    if (typeof exports === "string") {
        return subpath === "." ? exports : undefined;
    }

    if (exports === null || typeof exports !== "object") {
        return undefined;
    }

    const map = exports as Record<string, unknown>;
    const entry = Object.keys(map).some((key) => key.startsWith(".")) ? map[subpath] : subpath === "." ? map : undefined;

    return conditionTarget(entry);
}

function conditionTarget(entry: unknown): string | undefined {
    if (typeof entry === "string") {
        return entry;
    }

    if (entry === null || typeof entry !== "object") {
        return undefined;
    }

    const conditions = entry as Record<string, unknown>;

    for (const condition of ["import", "node", "default"]) {
        const target = conditionTarget(conditions[condition]);

        if (target) {
            return target;
        }
    }

    return undefined;
}
