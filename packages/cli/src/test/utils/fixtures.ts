import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const FIXTURES_ROOT = path.resolve(path.dirname(__filename), "../fixtures");

/**
 * Copies a named fixture directory tree into destDir.
 * Returns the path to the copied fixture root inside destDir.
 *
 * Usage:
 *   const fixturePath = copyFixture("simple", tmp.path);
 *   // fixturePath === "<tmp>/simple"
 */
export function copyFixture(fixtureName: string, destDir: string): string {
  const src = path.join(FIXTURES_ROOT, fixtureName);
  const dest = path.join(destDir, fixtureName);
  copyDirSync(src, dest);
  return dest;
}

function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
