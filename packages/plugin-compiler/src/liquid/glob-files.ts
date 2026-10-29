/**
 * Finding files for the `getFiles` and `listFiles` tags, through `host.globs`.
 */

import path from "node:path";
import type { HostGlobs } from "@sous-io/plugin-host/types";

/** One file found. */
export interface GlobFile {
    /** Absolute path. */
    path: string;
    /** Absolute path of its directory. */
    dir: string;
    /** Its path under the search root, `/`-separated. */
    relPath: string;
    /** Its base name (`get-thing.mjs`). */
    name: string;
}

/** What to search. */
export interface GlobFilesOptions {
    /** The absolute directory to search. */
    root: string;
    /** Patterns to include, relative to `root`. Default: everything (`**\/*`). */
    include?: string[];
    /** Patterns to leave out. */
    exclude?: string[];
}

/**
 * Every file under a root matching the include patterns and none of the exclude patterns, files
 * only, sorted by their path under the root.
 */
export async function globFiles(globs: Pick<HostGlobs, "match">, options: GlobFilesOptions): Promise<GlobFile[]> {
    const include = options.include?.length ? options.include : ["**/*"];
    const matches = await globs.match(include, { cwd: options.root, ignore: options.exclude ?? [], onlyFiles: true, dot: true });
    const unique = [...new Set(matches.map((match) => match.split(path.sep).join("/")))].sort((a, b) => a.localeCompare(b));

    return unique.map((relPath) => {
        const absPath = path.resolve(options.root, relPath);

        return { path: absPath, dir: path.dirname(absPath), relPath, name: path.basename(absPath) };
    });
}

/**
 * Splits a comma-separated glob attribute (`"*.mjs, !x.mjs"`) into trimmed, non-empty patterns.
 */
export function parseGlobList(value: string | undefined): string[] {
    if (!value) {
        return [];
    }

    return value
        .split(",")
        .map((pattern) => pattern.trim())
        .filter((pattern) => pattern.length > 0);
}
