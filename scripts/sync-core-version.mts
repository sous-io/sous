/**
 * Holds every workspace package, the packaged core recipe, and this
 * repository's own lockfile at the sous package's own version.
 *
 * The version comes from `packages/sous/package.json`, the package published
 * as `@sous-io/sous`. Every other `packages/<name>/package.json` shares that
 * one version, because they are released together: `@sous-io/plugin-api` is
 * published beside `@sous-io/sous`, and `pnpm publish` turns the `workspace:*`
 * range `@sous-io/sous` depends on it with into the version plugin-api's own
 * package.json declares at that moment. A plugin-api left behind would make
 * the published sous ask for an older plugin-api. So the script writes the
 * version into each of them.
 *
 * VERSION PARITY is a hard rule of the repositories design: every project's
 * implicit `core` subscription asks for exactly the running sous version, so
 * `recipes/core/sous-skills/sous.recipe.yaml` must declare exactly that
 * version too. The script writes it there, leaving the rest of the
 * hand-written manifest as it was.
 *
 * The same rule reaches this repository's committed `.sous/sous.lock.json`,
 * because sous builds itself with its own checkout: the moment the version
 * moves, the checkout asks for the new core version, and a lockfile still
 * pinning the old one is rewritten by the next build on whoever's machine runs
 * it. So the script also moves the lockfile's `core/sous-skills` entry to the
 * package version, with the hash of the packaged recipe as it now stands (the
 * hash a fresh seed computes), so the release commit leaves main consistent
 * with itself. A repository with no lockfile, or one that pins no core entry,
 * has nothing to move there and is left alone.
 *
 * The release workflow (`.github/workflows/publish.yml`) runs it right after it
 * settles on the version a merge publishes, so the packages, the recipe and the
 * lockfile are bumped in the same release commit. Run it by hand the same way
 * after editing the version in `packages/sous/package.json` in a pull request:
 *
 *     pnpm version:sync
 *
 * It is idempotent. A file already at the package version is left untouched,
 * byte for byte, a lockfile already pinning that version and hash is not
 * rewritten, and the script reports that it had nothing to do.
 *
 * It reads the workspace packages from their TypeScript source, so nothing has
 * to be built first (see `lib/from-source.mts`).
 *
 * @param argv[2] - Optional repository root; defaults to the repository this
 *   script lives in. Only the tests pass it.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runFromSource } from "./lib/from-source.mts";

/** The published package, whose package.json holds the version everything follows. */
const SOUS_PACKAGE_DIR = path.join("packages", "sous");

/** Where the packaged core recipe lives, relative to the repository root. */
const CORE_RECIPE_PATH = path.join("recipes", "core", "sous-skills");

/** The core recipe's key in a lockfile. */
const CORE_RECIPE_KEY = "core/sous-skills";

/** The lockfile, relative to the repository root. */
const LOCKFILE_PATH = path.join(".sous", "sous.lock.json");

/** What one synchronization did to one workspace package's package.json. */
export type PackageSyncResult = {
  /** The package.json that was inspected. */
  packageJsonPath: string;
  /** The version it declared before. */
  from: string;
  /** Whether it had to be rewritten. */
  changed: boolean;
};

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
  /** The version the sous package declares. */
  version: string;
  /** The version the recipe declared before. */
  from: string;
  /** Whether the recipe had to be rewritten. */
  changed: boolean;
  /** Every other workspace package, in directory order. */
  packages: PackageSyncResult[];
  /** The lockfile step; absent when the repository holds no lockfile pinning core. */
  lockfile?: LockSyncResult;
};

/** Reads the version `packages/sous/package.json` declares, or says why there is none. */
function readSousVersion(repoRoot: string): string {
  const packageJsonPath = path.join(repoRoot, SOUS_PACKAGE_DIR, "package.json");
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
        `  Every workspace package and the core recipe take their version from that field, ` +
        `so there is nothing to copy.`
    );
  }
  return parsed.version.trim();
}

/**
 * Writes the version into every `packages/<name>/package.json` other than the
 * sous package's own, editing only the `version` value so the rest of each
 * file keeps its layout.
 */
async function syncPackageVersions(repoRoot: string, version: string): Promise<PackageSyncResult[]> {
  const { parseDocument } = await import("../packages/documents/src/index.js");
  const packagesDir = path.join(repoRoot, "packages");
  if (!fs.existsSync(packagesDir)) return [];

  const results: PackageSyncResult[] = [];
  const names = fs
    .readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && path.join("packages", entry.name) !== SOUS_PACKAGE_DIR)
    .map((entry) => entry.name)
    .sort();

  for (const name of names) {
    const packageJsonPath = path.join(packagesDir, name, "package.json");
    if (!fs.existsSync(packageJsonPath)) continue;

    const text = fs.readFileSync(packageJsonPath, "utf8");
    const document = parseDocument(text, "json");
    const value = document.value() as { version?: unknown } | null;
    const from = typeof value?.version === "string" ? value.version : "(none)";
    const changed = from !== version;

    if (changed) {
      document.atPath(["version"]).set(version);
      fs.writeFileSync(packageJsonPath, document.toString(), "utf8");
    }
    results.push({ packageJsonPath, from, changed });
  }
  return results;
}

/**
 * Moves the lockfile's core entry to the given version and hash. Returns
 * undefined when there is no lockfile, or it pins no core entry.
 */
async function syncLockedCore(
  repoRoot: string,
  version: string,
  hash: string
): Promise<LockSyncResult | undefined> {
  const { lockfileFormat } = await import("../packages/plugin-formats/src/index.js");
  const lockfilePath = path.join(repoRoot, LOCKFILE_PATH);
  if (!fs.existsSync(lockfilePath)) return undefined;

  const lockfile = lockfileFormat.parse(JSON.parse(fs.readFileSync(lockfilePath, "utf8")), lockfilePath);
  const entry = lockfile.recipes[CORE_RECIPE_KEY];
  if (entry === undefined) return undefined;

  const result: LockSyncResult = {
    lockfilePath,
    from: entry.version,
    changed: entry.version !== version || entry.hash !== hash,
  };
  if (result.changed) {
    const updated = {
      ...lockfile,
      recipes: { ...lockfile.recipes, [CORE_RECIPE_KEY]: { ...entry, version, hash } },
    };
    // Through a temporary file, so a reader never sees half a lockfile.
    const temporary = `${lockfilePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, lockfileFormat.stringify(updated as typeof lockfile), "utf8");
    fs.renameSync(temporary, lockfilePath);
  }
  return result;
}

/**
 * Reads the sous package's version and writes it into every other workspace
 * package, into the packaged core recipe, then into the repository's own
 * lockfile when that pins a core entry.
 *
 * @param repoRoot - The root of the sous repository to work on.
 */
export async function syncCoreVersion(repoRoot: string): Promise<SyncResult> {
  const { hashDirectory } = await import("../packages/plugin-formats/src/index.js");
  const { findRecipeManifest } = await import("../packages/plugin-formats/src/manifests.js");
  const { setRecipeVersion } = await import("../packages/plugin-authoring/src/release/bump.js");

  const version = readSousVersion(repoRoot);

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
  const packages = await syncPackageVersions(repoRoot, version);

  // The hash is taken after the manifest moved, because the manifest is part
  // of the content and this is the hash a fresh seed will compute.
  const lockfile = await syncLockedCore(repoRoot, version, await hashDirectory(recipeDir));

  return {
    manifestPath,
    version,
    from: written.from,
    changed: written.from !== written.to,
    packages,
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
  const shown = (file: string): string => path.relative(repoRoot, file) || file;

  let result: SyncResult;
  try {
    result = await syncCoreVersion(repoRoot);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const moved = result.packages.filter((entry) => entry.changed);
  if (moved.length > 0) {
    console.log(`Set ${moved.length} workspace package${moved.length === 1 ? "" : "s"} to version ${result.version}:`);
    for (const entry of moved) console.log(`  ${shown(entry.packageJsonPath)}, from ${entry.from}`);
  } else if (result.packages.length > 0) {
    console.log(`Every workspace package already declares version ${result.version}.`);
  }

  if (result.changed) {
    console.log(
      `Set the core recipe in ${shown(result.manifestPath)} to version ${result.version}, from ${result.from}.`
    );
  } else {
    console.log(`The core recipe in ${shown(result.manifestPath)} already declares version ${result.version}.`);
  }

  if (result.lockfile !== undefined) {
    const lockShown = shown(result.lockfile.lockfilePath);
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

// Run as a command (the workflow, `pnpm version:sync`, the tests); importing
// the file only defines `syncCoreVersion`.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  runFromSource(import.meta.url);
  await main();
}
