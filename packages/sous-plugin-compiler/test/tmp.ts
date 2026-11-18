import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A temporary directory, and a way to remove it. */
export interface TmpDir {
    path: string;
    cleanup(): void;
}

/** Makes a temporary directory (its real path, links followed). */
export function makeTmpDir(prefix = "sous-test-"): TmpDir {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

    return { path: dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
