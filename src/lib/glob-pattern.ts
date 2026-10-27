/**
 * Filesystem paths as glob patterns.
 *
 * glob and minimatch read `\` in a pattern as an escape character, never as a
 * path separator, and want `/` on every platform. A pattern built with
 * `path.join` or `path.resolve` on Windows is all backslashes, so it silently
 * matched nothing: a recipe's skills, memories and config layers, an include
 * glob and an `entryGlob` target all came up empty without an error.
 */

import path from "node:path";

/**
 * Writes a path or a path-shaped glob with `/` separators, so glob reads it the
 * same way on Windows as everywhere else. A no-op where `/` is the separator, so
 * a pattern's own escapes survive on every other platform.
 *
 * toGlobPattern("C:\\recipes\\skills\\**\\*"); // -> "C:/recipes/skills/**\/*" on Windows
 *
 * @param value - A filesystem path, or a glob pattern built from one.
 */
export function toGlobPattern(value: string): string {
  return path.sep === "\\" ? value.split(path.sep).join("/") : value;
}
