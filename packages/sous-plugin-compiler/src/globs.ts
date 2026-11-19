/**
 * Expanding absolute glob patterns through `host.globs`, the one owner of globbing, and the order
 * the files of a glob include come in.
 */

import fs from "node:fs";
import path from "node:path";
import type { HostGlobs } from "@sous-io/sous-plugin-host/types";

/** The part of `host.globs` the compiler uses. */
export type Globs = Pick<HostGlobs, "matchSync" | "hasGlob" | "staticBase" | "isMatch" | "sortBytewise" | "compareBytewise" | "realPathInside">;

/**
 * Compares two paths in the order a glob include gives its files, the same on every machine:
 *
 * 1. At each folder, its own files come first, then its sub-folders, with the same rule inside each.
 * 2. Names are compared one character at a time, ignoring case, so `10-setup` comes before
 *    `2-setup`, and `0002` before `0010`.
 * 3. `_` comes before every other character; the rest go by character code, so digits come before
 *    letters.
 * 4. Two names that differ only by case put the capitalised one first.
 *
 * Paths may use `/` or `\` between their parts. A recipe's memories are ordered by the same rule.
 *
 * ```ts
 * ["m/zeta/last.md", "m/Zebra.md", "m/_intro.md", "m/2-setup.md", "m/10-setup.md"].sort(compareIncludeOrder);
 * // ["m/_intro.md", "m/10-setup.md", "m/2-setup.md", "m/Zebra.md", "m/zeta/last.md"]
 * ```
 */
export function compareIncludeOrder(left: string, right: string): number {
    const a = left.split(/[\\/]/);
    const b = right.split(/[\\/]/);

    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
        const leftIsFile = index === a.length - 1;
        const rightIsFile = index === b.length - 1;

        // A folder's own file comes before anything in one of its sub-folders.
        if (leftIsFile !== rightIsFile) {
            return leftIsFile ? -1 : 1;
        }

        const order = compareIncludeNames(a[index]!, b[index]!);

        if (order !== 0) {
            return order;
        }
    }

    return a.length - b.length;
}

/** One name against another, by the rules of {@link compareIncludeOrder}. */
function compareIncludeNames(left: string, right: string): number {
    const length = Math.min(left.length, right.length);

    for (let index = 0; index < length; index += 1) {
        const order = includeCharRank(left[index]!) - includeCharRank(right[index]!);

        if (order !== 0) {
            return order;
        }
    }

    if (left.length !== right.length) {
        return left.length - right.length;
    }

    // Equal but for case: the capitalised one first, by character code.
    return left < right ? -1 : left > right ? 1 : 0;
}

/** Where one character sorts: `_` first, then the rest by the code of its lower-case form. */
function includeCharRank(char: string): number {
    return char === "_" ? -1 : char.toLowerCase().charCodeAt(0);
}

/**
 * Every file an absolute pattern matches, as absolute paths in the order of
 * {@link compareIncludeOrder}.
 *
 * ```ts
 * expandPattern(globs, "/p/docs/**\/*.md");   // ["/p/docs/a.md", "/p/docs/b/c.md"]
 * ```
 */
export function expandPattern(globs: Globs, pattern: string, options: { dot?: boolean } = {}): string[] {
    // A pattern whose glob is only in parts already settled (a recipe glob's directory) is a path.
    if (!globs.hasGlob(pattern)) {
        return isFile(pattern) ? [path.resolve(pattern)] : [];
    }

    const normalized = pattern.split(path.sep).join("/");
    const base = globs.staticBase(normalized);
    const relative = base === "/" ? normalized.replace(/^\/+/, "") : normalized.slice(base.length).replace(/^\/+/, "");

    if (relative === "") {
        return [];
    }

    try {
        const matches = globs.matchSync(relative, { cwd: base, absolute: true, dot: options.dot ?? true, onlyFiles: true });

        return [...new Set(matches.map((file) => path.resolve(file)))].sort(compareIncludeOrder);
    } catch {
        return [];
    }
}

function isFile(file: string): boolean {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}
