/**
 * Holds the packaged core recipe at the sous package's own version.
 *
 * VERSION PARITY is a hard rule of the repositories design: every project's
 * implicit `core` subscription asks for exactly the running sous version, so
 * `recipes/core/sous-skills/sous.recipe.yaml` must declare exactly the version
 * in `package.json`. `src/lib/repos/core-recipe.spec.ts` fails the test run when
 * the two drift; this script is what puts them back in step.
 *
 * The release workflow (`.github/workflows/publish.yml`) runs it right after it
 * settles on the version a merge publishes, so the recipe is bumped in the same
 * release commit as `package.json` and `package-lock.json`. Run it by hand the
 * same way after editing the version in a pull request:
 *
 *     npx tsx scripts/sync-core-version.mts
 *
 * It is idempotent. A recipe already at the package version is left untouched,
 * byte for byte, and the script reports that it had nothing to do.
 *
 * @param argv[2] - Optional repository root; defaults to the repository this
 *   script lives in. Only the tests pass it.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CORE_RECIPE_PATH } from "../src/lib/repos/core-recipe.js";
import { findRecipeManifest } from "../src/lib/repos/load-manifest.js";
import { setRecipeVersion } from "../src/lib/repos/release/bump.js";

/** What one synchronization did. */
export type SyncResult = {
  /** The manifest that was inspected. */
  manifestPath: string;
  /** The version the package declares. */
  version: string;
  /** The version the recipe declared before. */
  from: string;
  /** Whether the recipe had to be rewritten. */
  changed: boolean;
};

/**
 * Reads the package version and writes it into the packaged core recipe.
 *
 * @param repoRoot - The root of the sous repository to work on.
 */
export function syncCoreVersion(repoRoot: string): SyncResult {
  const packageJsonPath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(
      `There is no package.json at ${packageJsonPath}.\n` +
        `  This script reads the sous package's version from there, so it has to be run ` +
        `against a sous repository.`
    );
  }

  const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version.trim() === "") {
    throw new Error(
      `The package.json at ${packageJsonPath} declares no version.\n` +
        `  The core recipe takes its version from that field, so there is nothing to copy.`
    );
  }
  const version = parsed.version.trim();

  const recipeDir = path.join(repoRoot, CORE_RECIPE_PATH);
  const manifestPath = findRecipeManifest(recipeDir);
  if (manifestPath === undefined) {
    throw new Error(
      `There is no core recipe manifest in ${recipeDir}.\n` +
        `  The packaged core recipe is the offline seed every install ships; restore it, ` +
        `then run this script again.`
    );
  }

  const written = setRecipeVersion(manifestPath, version);
  return {
    manifestPath,
    version,
    from: written.from,
    changed: written.from !== written.to,
  };
}

/**
 * The command line around `syncCoreVersion`: resolve the repository root, do
 * the work, and say in plain language what happened.
 */
function main(): void {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(process.argv[2] ?? path.join(scriptDir, ".."));

  let result: SyncResult;
  try {
    result = syncCoreVersion(repoRoot);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const shown = path.relative(repoRoot, result.manifestPath) || result.manifestPath;
  if (result.changed) {
    console.log(
      `Set the core recipe in ${shown} to version ${result.version}, from ${result.from}.`
    );
  } else {
    console.log(`The core recipe in ${shown} already declares version ${result.version}.`);
  }
}

// Only a test imports this file; every other run is the command line.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main();
}
