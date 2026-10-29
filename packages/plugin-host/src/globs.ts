/** `host.globs`: matching, a pattern's static base, bytewise order, and "is this path inside that one". */

import { globSync, glob } from "glob";
import { minimatch } from "minimatch";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { GlobMatchOptions, GlobOptions, HostGlobs } from "./types.js";

/** The characters a glob pattern is made of. */
const GLOB_CHARS = /[*?[\]{}]/;

/** The characters that start a glob segment when finding a pattern's static base. */
const BASE_STOP = /[*?{[]/;

/** Whether text holds glob syntax. */
export function hasGlob(text: string): boolean {
    return GLOB_CHARS.test(text);
}

/**
 * The directory part of a pattern before its first glob segment.
 *
 * ```ts
 * staticBase("docs/**\/*.md"); // "docs"
 * staticBase("*.md");          // "/"
 * ```
 */
export function staticBase(pattern: string): string {
    const staticParts: string[] = [];

    for (const part of pattern.split("/")) {
        if (BASE_STOP.test(part)) {
            break;
        }

        staticParts.push(part);
    }

    // A trailing slash leaves an empty last part.
    if (staticParts.length > 0 && staticParts[staticParts.length - 1] === "") {
        staticParts.pop();
    }

    return staticParts.join("/") || "/";
}

/** Compares two strings by their UTF-8 bytes, so the order is the same on every machine. */
export function compareBytewise(left: string, right: string): number {
    return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

/** A path with `/` separators. */
export function toPosix(value: string): string {
    return path.sep === "/" ? value : value.split(path.sep).join("/");
}

/** Whether `child` is `parent` or inside it, comparing resolved paths as text. */
function textInside(child: string, parent: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(child));

    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * The real path of a path that may not exist yet: the real path of its nearest existing ancestor,
 * with the missing part added back. `undefined` when no ancestor can be resolved.
 */
function realPathOfMaybeMissing(target: string): string | undefined {
    const missing: string[] = [];
    let current = path.resolve(target);

    for (;;) {
        try {
            return path.join(realpathSync(current), ...missing.reverse());
        } catch {
            const parent = path.dirname(current);

            if (parent === current) {
                return undefined;
            }

            missing.push(path.basename(current));
            current = parent;
        }
    }
}

/** Reads the patterns option into the list `glob` wants. */
function toList(patterns: string | readonly string[]): string[] {
    return typeof patterns === "string" ? [patterns] : [...patterns];
}

/** What `glob` is told, from our options. */
function globOptions(options: GlobOptions) {
    return {
        cwd: options.cwd,
        dot: options.dot ?? false,
        absolute: options.absolute ?? false,
        nodir: options.onlyFiles ?? true,
        ignore: options.ignore === undefined ? undefined : [...options.ignore],
        follow: options.followSymlinks ?? true,
    };
}

/** Sorts matches bytewise, with `/` separators unless they are absolute. */
function finish(matches: string[], options: GlobOptions): string[] {
    return matches.map((match) => (options.absolute === true ? match : toPosix(match))).sort(compareBytewise);
}

/** The `host.globs` service. */
export const hostGlobs: HostGlobs = {
    async match(patterns, options) {
        return finish(await glob(toList(patterns), globOptions(options)), options);
    },

    matchSync(patterns, options) {
        return finish(globSync(toList(patterns), globOptions(options)), options);
    },

    isMatch(candidate, pattern, options: GlobMatchOptions = {}) {
        const matcher = { dot: options.dot ?? false, nocase: options.nocase ?? false };

        return toList(pattern).some((single) => minimatch(candidate, single, matcher));
    },

    hasGlob,
    staticBase,
    compareBytewise,

    sortBytewise(items) {
        return [...items].sort(compareBytewise);
    },

    isInside(child, parent, options = {}) {
        if (options.realPath !== true) {
            return textInside(child, parent);
        }

        const realChild = realPathOfMaybeMissing(child);
        const realParent = realPathOfMaybeMissing(parent);

        return realChild !== undefined && realParent !== undefined && textInside(realChild, realParent);
    },

    realPathInside(target, root) {
        const real = realPathOfMaybeMissing(target);
        const realRoot = realPathOfMaybeMissing(root);

        return real !== undefined && realRoot !== undefined && textInside(real, realRoot) ? real : undefined;
    },

    toPosix,
};
