/**
 * Where this installation of sous lives, and what version it is.
 *
 * These two facts are needed by modules at every level, including ones that
 * `settings.ts` itself imports, so they live in their own dependency-free module
 * rather than in `settings.ts`. `settings.ts` re-exports both under their
 * long-standing names, so nothing else has to care where they moved to.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

/** Resolved path to the package root (two levels up from `src/lib/`). */
export const CLI_ROOT = path.resolve(path.dirname(__filename), "../..");

/** Version string read from the package's own package.json at module load time. */
const packageJson = JSON.parse(
  fs.readFileSync(path.join(CLI_ROOT, "package.json"), "utf8")
) as { version: string };

/** The running sous version. */
export const SOUS_VERSION: string = packageJson.version;
