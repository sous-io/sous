/**
 * The canonical content hash of a recipe folder.
 *
 * Decision 12 of the Repositories design specifies "SHA-256 over a canonical
 * tar of the recipe folder". This module computes exactly that idea WITHOUT a
 * tar dependency: instead of serializing a real tar archive, it feeds the hash
 * a canonical byte stream built from the same information a tar entry would
 * carry that we actually care about (the path and the file's bytes), in a
 * canonical order. Tar's variable header fields (mode, owner, group, mtime,
 * block padding, format flavour) are deliberately excluded, so the same tree
 * hashes the same after a copy, a clone or an archive round-trip on a different
 * machine.
 *
 * The stream, per file, is:
 *
 *     <relative path (posix separators)> NUL <byte length> NUL <bytes> NUL
 *
 * Files are visited in bytewise order of their relative paths. `.git` and the
 * store's own `.sous.entry.json` marker are skipped, so an entry's hash is
 * independent of the marker that records it. Symlinks are followed and hashed
 * as the file they point at. Empty directories contribute nothing, since they
 * carry no content a recipe can use.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { STORE_ENTRY_FILENAME } from "../formats/common.js";

/** Directory name never included in a content hash. */
const GIT_DIR_NAME = ".git";

/** The separator byte between the fields of one file's canonical record. */
const FIELD_SEPARATOR = Buffer.from([0]);

/**
 * Collects every hashable file under `dir`, as paths relative to `dir` and
 * always with posix separators, so a hash computed on Windows matches one
 * computed on Linux.
 *
 * @param dir - The directory to walk.
 * @param prefix - The relative path of `dir` within the tree being hashed.
 */
async function collectFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    if (entry.name === GIT_DIR_NAME) continue;
    if (entry.name === STORE_ENTRY_FILENAME) continue;

    const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(dir, entry.name);

    // A symlink is followed and treated as whatever it points at, so stat (not
    // lstat) decides. A dangling link is skipped rather than failing the hash.
    let isDirectory: boolean;
    try {
      const stats = await fs.stat(absolute);
      isDirectory = stats.isDirectory();
      if (!isDirectory && !stats.isFile()) continue;
    } catch {
      continue;
    }

    if (isDirectory) found.push(...(await collectFiles(absolute, relative)));
    else found.push(relative);
  }

  return found;
}

/** Orders two relative paths bytewise, so the ordering never depends on a locale. */
function bytewiseCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Computes the canonical content hash of a directory tree, returned as
 * `sha256-` followed by 64 lowercase hexadecimal characters (the shape
 * `contentHashSchema` validates).
 *
 * @param dir - Absolute path to the directory to hash.
 */
export async function hashDirectory(dir: string): Promise<string> {
  const root = path.resolve(dir);
  const files = (await collectFiles(root)).sort(bytewiseCompare);
  const hash = createHash("sha256");

  for (const relative of files) {
    const bytes = await fs.readFile(path.join(root, ...relative.split("/")));
    hash.update(Buffer.from(relative, "utf8"));
    hash.update(FIELD_SEPARATOR);
    hash.update(Buffer.from(String(bytes.byteLength), "utf8"));
    hash.update(FIELD_SEPARATOR);
    hash.update(bytes);
    hash.update(FIELD_SEPARATOR);
  }

  return `sha256-${hash.digest("hex")}`;
}

/**
 * Compares two content hashes. Both are canonical lowercase strings, so this is
 * an exact comparison; it exists so callers read as intent rather than as
 * string equality, and so a future multi-algorithm form has one place to land.
 *
 * @param a - The first hash.
 * @param b - The second hash.
 */
export function hashesEqual(a: string, b: string): boolean {
  return a === b;
}
