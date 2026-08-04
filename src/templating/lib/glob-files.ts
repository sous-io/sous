import path from "node:path";
import { glob } from "glob";

/** A single file discovered by {@link globFiles}. */
export interface GlobFile {
  /** Absolute path to the file. */
  path: string;
  /** Absolute path to the file's directory. */
  dir: string;
  /** Path relative to the search root (POSIX separators). */
  relPath: string;
  /** File's basename (e.g. "get-thing.mjs"). */
  name: string;
}

/** Options controlling a {@link globFiles} search. */
export interface GlobFilesOptions {
  /** Absolute directory to search within. */
  root: string;
  /** Glob patterns to include. Defaults to everything (`**\/*`). */
  include?: string[];
  /** Glob patterns to exclude. */
  exclude?: string[];
}

/**
 * Find files under a root directory matching include globs and not matching
 * exclude globs. Patterns are matched relative to `root`. Results are files
 * only (no directories), sorted by relative path for deterministic output.
 *
 * @param options - The search root and include/exclude glob patterns.
 * @returns A sorted array of matched files.
 */
export async function globFiles(options: GlobFilesOptions): Promise<GlobFile[]> {
  const { root } = options;
  const include = options.include?.length ? options.include : ["**/*"];
  const exclude = options.exclude ?? [];

  const matches = await glob(include, {
    cwd: root,
    ignore: exclude,
    nodir: true,
    dot: true,
    posix: true,
  });

  const unique = [...new Set(matches)].sort((a, b) => a.localeCompare(b));

  return unique.map((relPath) => {
    const absPath = path.resolve(root, relPath);
    return {
      path: absPath,
      dir: path.dirname(absPath),
      relPath,
      name: path.basename(absPath),
    };
  });
}

/**
 * Parse a comma-separated glob attribute (e.g. `"*.mjs, !x.mjs"`) into a
 * trimmed list of non-empty patterns. Returns an empty array for
 * undefined/blank input.
 *
 * @param value - The raw attribute string, or undefined.
 * @returns The parsed pattern list.
 */
export function parseGlobList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
