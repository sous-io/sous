import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type TmpDir = {
  /** Absolute path to the temporary directory. */
  path: string;
  /** Removes the directory and all its contents. */
  cleanup: () => void;
};

/**
 * Creates a unique temporary directory under os.tmpdir().
 * Returns the path and a cleanup function.
 *
 * Usage:
 *   const tmp = makeTmpDir();
 *   // ... use tmp.path ...
 *   tmp.cleanup();
 */
export function makeTmpDir(prefix = "sous-test-"): TmpDir {
  const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    path: dirPath,
    cleanup: () => fs.rmSync(dirPath, { recursive: true, force: true }),
  };
}
