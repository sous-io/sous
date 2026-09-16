/**
 * Holds the packaged core recipe, and this repository's own lockfile, at the
 * sous package's own version.
 *
 * VERSION PARITY is a hard rule of the repositories design: every project's
 * implicit `core` subscription asks for exactly the running sous version, so
 * `recipes/core/sous-skills/sous.recipe.yaml` must declare exactly the version
 * in `package.json`. `src/lib/repos/core-recipe.spec.ts` fails the test run when
 * the two drift; this script is what puts them back in step.
 *
 * The same rule reaches this repository's committed `.sous/sous.lock.json`,
 * because sous builds itself with its own checkout: the moment `package.json`
 * moves, the checkout asks for the new core version, and a lockfile still
 * pinning the old one is rewritten by the next build on whoever's machine runs
 * it. So the script also moves the lockfile's `core/sous-skills` entry to the
 * package version, with the hash of the packaged recipe as it now stands (the
 * hash a fresh seed computes), so the release commit leaves main consistent
 * with itself. A repository with no lockfile, or one that pins no core entry,
 * has nothing to move there and is left alone.
 *
 * The release workflow (`.github/workflows/publish.yml`) runs it right after it
 * settles on the version a merge publishes, so the recipe and the lockfile are
 * bumped in the same release commit as `package.json` and `package-lock.json`.
 * Run it by hand the same way after editing the version in a pull request:
 *
 *     npx tsx scripts/sync-core-version.mts
 *
 * It is idempotent. A recipe already at the package version is left untouched,
 * byte for byte, a lockfile already pinning that version and hash is not
 * rewritten, and the script reports that it had nothing to do.
 *
 * @param argv[2] - Optional repository root; defaults to the repository this
 *   script lives in. Only the tests pass it.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CORE_RECIPE_KEY, CORE_RECIPE_PATH } from "../src/lib/repos/core-recipe.js";
import { findRecipeManifest } from "../src/lib/repos/load-manifest.js";
import { LockService } from "../src/lib/repos/lock-service.js";
import { setRecipeVersion } from "../src/lib/repos/release/bump.js";
import { hashDirectory } from "../src/lib/repos/store/hash.js";

/** What one synchronization did to the lockfile, when there was one to do it to. */
export type LockSyncResult = {
  /** The lockfile that was inspected. */
  lockfilePath: string;
  /** The version the core entry pinned before. */
  from: string;
  /** Whether the entry had to be rewritten (a new version, or a new hash). */
  changed: boolean;
};

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
  /** The lockfile step; absent when the repository holds no lockfile pinning core. */
  lockfile?: LockSyncResult;
};

/**
 * Moves the lockfile's core entry to the given version and hash. Returns
 * undefined when there is no lockfile, or it pins no core entry.
 */
function syncLockedCore(
  repoRoot: string,
  version: string,
  hash: string
): LockSyncResult | undefined {
  const lock = new LockService(path.join(repoRoot, ".sous"));
  if (!fs.existsSync(lock.filePath)) return undefined;

  const lockfile = lock.read();
  const entry = lockfile.recipes[CORE_RECIPE_KEY];
  if (entry === undefined) return undefined;

  const result: LockSyncResult = {
    lockfilePath: lock.filePath,
    from: entry.version,
    changed: entry.version !== version || entry.hash !== hash,
  };
  if (result.changed) {
    lock.write({
      ...lockfile,
      recipes: { ...lockfile.recipes, [CORE_RECIPE_KEY]: { ...entry, version, hash } },
    });
  }
  return result;
}

/**
 * Reads the package version and writes it into the packaged core recipe, then
 * into the repository's own lockfile when that pins a core entry.
 *
 * @param repoRoot - The root of the sous repository to work on.
 */
export async function syncCoreVersion(repoRoot: string): Promise<SyncResult> {
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

  // The hash is taken after the manifest moved, because the manifest is part
  // of the content and this is the hash a fresh seed will compute.
  const lockfile = syncLockedCore(repoRoot, version, await hashDirectory(recipeDir));

  return {
    manifestPath,
    version,
    from: written.from,
    changed: written.from !== written.to,
    ...(lockfile === undefined ? {} : { lockfile }),
  };
}

/**
 * The command line around `syncCoreVersion`: resolve the repository root, do
 * the work, and say in plain language what happened.
 */
async function main(): Promise<void> {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(process.argv[2] ?? path.join(scriptDir, ".."));

  let result: SyncResult;
  try {
    result = await syncCoreVersion(repoRoot);
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

  if (result.lockfile !== undefined) {
    const lockShown = path.relative(repoRoot, result.lockfile.lockfilePath) || result.lockfile.lockfilePath;
    if (result.lockfile.changed) {
      console.log(
        `Pinned core in ${lockShown} at version ${result.version}, from ${result.lockfile.from}, ` +
          `with the packaged recipe's hash.`
      );
    } else {
      console.log(`The lockfile ${lockShown} already pins core at version ${result.version}.`);
    }
  }
}

// Only a test imports this file; every other run is the command line.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  await main();
}
