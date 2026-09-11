/**
 * Seeding the store with the core recipe that ships inside the package.
 *
 * Every project is subscribed to the `core` namespace, and a project must be
 * able to build with no network at all, including the very first time sous runs
 * on a machine. That is what this module is for: it copies the packaged core
 * recipe into the machine-wide store and, when nothing has ever been fetched
 * from the official repository, writes a small stand-in index so the resolver
 * can find the recipe it has just seeded.
 *
 * Three properties matter, and each one is deliberate:
 *
 *   - IDEMPOTENT. Seeding runs before every build. When the store already holds
 *     a verifying entry at this version, nothing is copied and nothing is
 *     written.
 *   - OFFLINE. Nothing here touches the network, and nothing here fails a build.
 *     A store that cannot be written is reported and the build carries on
 *     without core, which is far better than refusing to run.
 *   - REPLACEABLE. The stand-in index is written only when the cache holds no
 *     real index for the official repository. It carries a note saying sous
 *     wrote it, so a later run recognizes its own placeholder and is willing to
 *     replace it; the first successful fetch overwrites it with the real thing.
 */

import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import {
  parseIndexFile,
  stringifyIndexFile,
  type IndexFile,
} from "./formats/index-file.js";
import { INDEX_CACHE_DIRNAME, INDEX_SIDECAR_SUFFIX } from "./providers/index-cache.js";
import { identitySegments } from "./identity.js";
import { ensureIndexCacheDirectory } from "../../utils/sous-directory.js";
import type { RecipeStoreLike, StoreKey } from "./store/contract.js";
import {
  CORE_NAMESPACE,
  CORE_RECIPE_KEY,
  CORE_RECIPE_NAME,
  CORE_RECIPE_PATH,
  OFFICIAL_REPO_IDENTITY,
  OFFICIAL_REPO_NAME,
  packagedCoreRecipeDir,
  readPackagedCoreManifest,
} from "./core-recipe.js";

/**
 * The note the seed index carries in its `$comment` field. A cached index
 * carrying this exact text is sous's own placeholder rather than something a
 * repository published, so a later seed may overwrite it.
 */
export const SEED_INDEX_COMMENT =
  "Written by sous itself from the core recipe inside the installed package, so a " +
  "project can build before it has ever reached the network. The first successful " +
  "fetch of the real index replaces this file.";

/** The description the seed index gives the core namespace. */
const CORE_NAMESPACE_DESCRIPTION =
  "Skills that teach an agent about sous itself: what sous manages, how its " +
  "configuration works, how templates render, and how skills are written. " +
  "Auto-subscribed in every project, with opt-out-only semantics.";

/** What the seed is asked to do. */
export type SeedCoreRecipeOptions = {
  /** The store to seed. */
  store: RecipeStoreLike;
  /** The store's root directory, which is where the index cache lives. */
  storeRoot?: string;
  /** The version to seed, which is by rule the running sous version. */
  sousVersion: string;
  /** The installed package's root directory. Defaults to the running CLI's own. */
  packageRoot?: string;
  /** The clock, so a written timestamp is predictable in tests. */
  now?: () => Date;
};

/** What the seed did. */
export type SeedCoreRecipeReport = {
  /** True when the recipe's files were copied into the store on this run. */
  seeded: boolean;
  /** True when the store already held a verifying entry, so nothing was copied. */
  alreadyPresent: boolean;
  /** True when a stand-in index was written for the official repository. */
  wroteIndex: boolean;
  /** The version that was seeded. */
  version: string;
  /** The content hash of the seeded entry, when there is one. */
  hash?: string;
  /**
   * Why the seed did nothing, when it could not run. A complete sentence, meant
   * to be shown as a warning; the seed never throws.
   */
  skippedBecause?: string;
};

/**
 * Copies the packaged core recipe into the store and, when nothing real is
 * cached, writes a stand-in index for the official repository so the resolver
 * can see what was just seeded.
 *
 * @param options - The store to seed, the version to seed it at, and the clock.
 */
export async function seedCoreRecipe(
  options: SeedCoreRecipeOptions
): Promise<SeedCoreRecipeReport> {
  const version = options.sousVersion;
  const now = options.now ?? (() => new Date());
  const storeRoot = options.storeRoot ?? options.store.root;

  const key: StoreKey = {
    identity: OFFICIAL_REPO_IDENTITY,
    namespace: CORE_NAMESPACE,
    name: CORE_RECIPE_NAME,
    version,
  };

  const report: SeedCoreRecipeReport = {
    seeded: false,
    alreadyPresent: false,
    wroteIndex: false,
    version,
  };

  try {
    const existing = await options.store.get(key);

    if (existing !== undefined) {
      report.alreadyPresent = true;
      report.hash = existing.entry.hash;
    } else {
      const source = packagedCoreRecipeDir(options.packageRoot);
      const entry = await options.store.put(key, source);
      report.seeded = true;
      report.hash = entry.hash;
    }

    report.wroteIndex = writeSeedIndex({
      storeRoot,
      version,
      hash: report.hash!,
      now: now(),
      ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
    });
  } catch (error) {
    // Seeding is a convenience, not a precondition: a read-only store or a
    // damaged package must not stop a build that may not even use recipes.
    report.skippedBecause =
      `Sous could not seed the core recipe it ships with, so the skills in the ` +
      `'core' namespace are unavailable until this is fixed.\n` +
      `${error instanceof Error ? error.message : String(error)}`;
  }

  return report;
}

/**
 * Writes the stand-in index for the official repository, unless the cache
 * already holds one that a repository actually published.
 *
 * Returns true when a file was written.
 *
 * @param input - Where the cache is, and what the seeded entry looks like.
 */
function writeSeedIndex(input: {
  storeRoot: string;
  version: string;
  hash: string;
  now: Date;
  packageRoot?: string;
}): boolean {
  // The cache files an index under the repository's identity, which is several
  // directories deep; the seed writes to exactly the same place a real fetch
  // would, so the first successful fetch replaces this copy rather than
  // sitting beside it.
  const segments = identitySegments(OFFICIAL_REPO_IDENTITY);
  const last = segments.pop()!;
  const directory = path.join(input.storeRoot, INDEX_CACHE_DIRNAME, ...segments);
  const indexPath = path.join(directory, `${last}.json`);
  const sidecarPath = path.join(directory, `${last}${INDEX_SIDECAR_SUFFIX}`);

  if (!isReplaceableIndex(indexPath, input.version)) return false;

  const manifest = readPackagedCoreManifest(input.packageRoot);
  const timestamp = input.now.toISOString();

  const index: IndexFile = {
    $comment: SEED_INDEX_COMMENT,
    formatVersion: 1,
    name: OFFICIAL_REPO_NAME,
    generatedAt: timestamp,
    generator: input.version,
    namespaces: {
      [CORE_NAMESPACE]: { description: CORE_NAMESPACE_DESCRIPTION },
    },
    recipes: {
      [CORE_RECIPE_KEY]: {
        path: CORE_RECIPE_PATH,
        ...(manifest.description === undefined
          ? {}
          : { description: manifest.description }),
        versions: {
          [input.version]: {
            hash: input.hash,
            tag: `${CORE_RECIPE_KEY}@${input.version}`,
            prerelease: semver.prerelease(input.version) !== null,
            releasedAt: timestamp,
          },
        },
      },
    },
  };

  // No sidecar is written, deliberately. The sidecar is what says "this copy was
  // fetched at such a time", and this copy was not fetched at all. Without one,
  // sous treats the stand-in as infinitely old and tries upstream on the very
  // next command: the first run with a network gets the real index immediately
  // rather than waiting out a freshness window it never earned. When there is no
  // network the fetch fails, the stand-in is used, and sous says so, which is the
  // same last-good behavior every other repository gets.
  //
  // Any sidecar left over from an earlier fetch is removed for the same reason.
  ensureIndexCacheDirectory(path.join(input.storeRoot, INDEX_CACHE_DIRNAME));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(indexPath, stringifyIndexFile(index), "utf8");
  fs.rmSync(sidecarPath, { force: true });
  return true;
}

/**
 * True when the seed may write over whatever is at `indexPath`.
 *
 * Three cases, in order:
 *
 *   - Nothing cached, or a cached file that no longer parses: write. A damaged
 *     copy is worth less than a stand-in that works.
 *   - A stand-in sous wrote itself that does not name the version being seeded:
 *     write. This is how a machine that upgrades sous while offline ends up with
 *     an index naming the new version.
 *   - Anything else, including sous's own stand-in that already names this
 *     version: leave it alone. Rewriting it on every build would reset the
 *     freshness clock, and sous would then never look upstream for the real one.
 *
 * @param indexPath - Where the cached index for the official repository lives.
 * @param version - The version being seeded.
 */
function isReplaceableIndex(indexPath: string, version: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(indexPath, "utf8");
  } catch {
    return true;
  }

  let cached: IndexFile;
  try {
    cached = parseIndexFile(JSON.parse(text), indexPath);
  } catch {
    return true;
  }

  if (cached.$comment !== SEED_INDEX_COMMENT) return false;
  return cached.recipes[CORE_RECIPE_KEY]?.versions[version] === undefined;
}
