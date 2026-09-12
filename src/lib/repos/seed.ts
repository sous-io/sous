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
 *
 * The stand-in alone is not enough, and that is what `coreIndexOverlay` is for.
 * A machine that has already fetched the real index keeps it, quite rightly, and
 * that index publishes whatever versions of the core recipe the repository has
 * released. Upgrade sous and the version it asks for is, for a while, one the
 * repository has not published yet: the real index wins over the stand-in, the
 * resolver finds nothing satisfying the range, and the project silently loses
 * its core skills until the release pipeline catches up. So the packaged version
 * is folded into the index IN MEMORY whenever it is missing, carrying the hash
 * of the entry that was just seeded. The cached file is never touched, so it
 * stays an honest record of what upstream served, and the moment upstream does
 * publish that version its own entry is what gets used.
 */

import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import {
  parseIndexFile,
  stringifyIndexFile,
  type IndexFile,
} from "./formats/index-file.js";
import {
  INDEX_CACHE_DIRNAME,
  INDEX_SIDECAR_SUFFIX,
  type IndexOverlay,
} from "./providers/index-cache.js";
import { warning } from "../../utils/formatting.js";
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
  /**
   * The index cache to teach about the packaged version, once the seed knows
   * its hash. Without this the seeded recipe is resolvable only on a machine
   * whose cached index is sous's own stand-in.
   */
  indexCache?: IndexOverlayTarget;
  /** Where warnings go. Defaults to the console warning banner. */
  warn?: (message: string) => void;
};

/**
 * The part of the index cache the seed uses: somewhere to install what it has
 * learned. Named as a small structural type so the seed does not depend on the
 * cache's implementation.
 */
export type IndexOverlayTarget = {
  setOverlay(overlay: IndexOverlay | undefined): void;
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

    // The cache is taught before the stand-in is considered, because the two
    // answer different halves of the same problem: the stand-in covers a machine
    // that has never fetched anything, and the overlay covers one that has.
    options.indexCache?.setOverlay(
      coreIndexOverlay({
        version,
        hash: report.hash!,
        ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
        ...(options.warn === undefined ? {} : { warn: options.warn }),
      })
    );

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

/** What the overlay needs to know about the version sous ships. */
export type CoreIndexOverlayOptions = {
  /** The packaged version, which is by rule the running sous version. */
  version: string;
  /** The content hash of the entry the seed put in the store. */
  hash: string;
  /** The installed package's root directory. Defaults to the running CLI's own. */
  packageRoot?: string;
  /** Where the one warning this can produce goes. Defaults to the console banner. */
  warn?: (message: string) => void;
};

/**
 * Builds the overlay that makes the packaged core recipe resolvable whatever
 * the official repository has published so far.
 *
 * Three cases, and the order matters:
 *
 *   - The index already publishes this version with this hash: nothing to add,
 *     and the index is returned untouched. This is the ordinary case once the
 *     release pipeline has caught up.
 *   - The index publishes this version with a DIFFERENT hash: upstream wins, and
 *     sous says so once. The two are built from the same bytes, so this should
 *     not happen; when it does, the version a repository published is the one a
 *     lockfile should be able to pin on any machine, seeded or not.
 *   - The index does not publish this version at all: it is added, carrying the
 *     hash of the entry the seed just wrote and marked `seeded` so a listing can
 *     say it came packaged with sous.
 *
 * Nothing here writes anything. The returned index is a copy; the one passed in
 * is left exactly as it was read.
 *
 * @param options - The packaged version, its hash, and where a warning goes.
 */
export function coreIndexOverlay(options: CoreIndexOverlayOptions): IndexOverlay {
  let warned = false;

  return (identity: string, index: IndexFile): IndexFile => {
    if (identity !== OFFICIAL_REPO_IDENTITY) return index;

    const published = index.recipes[CORE_RECIPE_KEY]?.versions[options.version];

    if (published !== undefined) {
      if (published.hash !== options.hash && !warned) {
        warned = true;
        (options.warn ?? warning)(
          `The repository '${OFFICIAL_REPO_NAME}' publishes version ${options.version} of ` +
            `'${CORE_RECIPE_KEY}' with different contents from the copy inside this ` +
            `installation of sous, so sous is using the published one.\n` +
            `  Published: ${published.hash}\n` +
            `  Packaged:  ${options.hash}\n` +
            `  Reinstalling sous will bring the two back into line.`
        );
      }
      return index;
    }

    const recipe = index.recipes[CORE_RECIPE_KEY];
    const description = recipe?.description ?? packagedCoreDescription(options.packageRoot);

    return {
      ...index,
      namespaces: {
        ...index.namespaces,
        [CORE_NAMESPACE]: index.namespaces[CORE_NAMESPACE] ?? {
          description: CORE_NAMESPACE_DESCRIPTION,
        },
      },
      recipes: {
        ...index.recipes,
        [CORE_RECIPE_KEY]: {
          path: recipe?.path ?? CORE_RECIPE_PATH,
          ...(description === undefined ? {} : { description }),
          versions: {
            ...recipe?.versions,
            [options.version]: {
              hash: options.hash,
              tag: `${CORE_RECIPE_KEY}@${options.version}`,
              prerelease: semver.prerelease(options.version) !== null,
              seeded: true,
            },
          },
        },
      },
    };
  };
}

/**
 * The packaged recipe's one-paragraph summary, or undefined when the manifest
 * cannot be read. A description is decoration; losing it must not cost a project
 * its core skills.
 *
 * @param packageRoot - The installed package's root directory.
 */
function packagedCoreDescription(packageRoot?: string): string | undefined {
  try {
    return readPackagedCoreManifest(packageRoot).description;
  } catch {
    return undefined;
  }
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
            seeded: true,
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
