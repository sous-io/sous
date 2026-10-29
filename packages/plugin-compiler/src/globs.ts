/**
 * Expanding absolute glob patterns through `host.globs`, the one owner of globbing (S6).
 */

import fs from "node:fs";
import path from "node:path";
import type { HostGlobs } from "@sous-io/plugin-host/types";

/** The part of `host.globs` the compiler uses. */
export type Globs = Pick<HostGlobs, "matchSync" | "hasGlob" | "staticBase" | "isMatch" | "sortBytewise" | "compareBytewise" | "realPathInside">;

/**
 * Every file an absolute pattern matches, as absolute paths in bytewise order.
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

        return globs.sortBytewise(new Set(matches.map((file) => path.resolve(file))));
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
