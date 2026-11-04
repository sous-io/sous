/**
 * The project lockfile: `.sous/sous.lock.json`, committed to the project.
 *
 * The lockfile is MACHINE-WRITTEN and records the exact version and content
 * hash of everything a project currently uses, so a fresh clone restores
 * deterministically with no prompts and no version drift. Together with repo
 * trust it is the supply-chain defense: nothing new enters a project except
 * through an explicit, visible change to these files.
 *
 * A repository appears twice over: the project's own short name is the key of
 * the `repos` map and is what every recipe entry and every message names, while
 * the entry's `identity` is what the machine-wide store is keyed by.
 *
 * `requestedBy` is what makes removal safe. Every entry lists who holds it, the
 * literal string `project` for something the project subscribed to directly and
 * a recipe key for something pulled in as a dependency. Unsubscribing removes
 * one holder; the entry itself goes only when the last holder does.
 *
 * `pins` holds the versions pinned for one holder alone (ADR 0023, decision 4).
 * A recipe a holder reaches only through `depends` adds no files to the project,
 * so a holder whose range does not allow the shared `version` gets a version of
 * its own, keyed by the holder's recipe key. Every holder in `pins` is also in
 * `requestedBy`; a holder not in `pins` uses `version`. An entry without
 * per-holder pins has no `pins` key at all, so such a lockfile reads the same as
 * before. An older sous reading an entry with `pins` refuses the lockfile,
 * naming the unknown key, since this format is strict.
 */

import { z } from "zod";
import {
  contentHashSchema,
  formatVersionSchema,
  parseFormat,
  recipeKeySchema,
  repoIdentitySchema,
  repoNameSchema,
  repoUrlSchema,
  semverVersionSchema,
  stableJsonStringify,
  DEPENDENCY_KINDS,
  type DependencyKind,
} from "./common.js";

/** The literal `requestedBy` holder meaning "the project subscribed to this directly". */
export const PROJECT_HOLDER = "project";

/** How a locked recipe entered the project: the dependency kinds every format shares. */
export const LOCK_KINDS = DEPENDENCY_KINDS;

/**
 * One repository the lockfile describes. An older file may lack `identity`; the
 * parser leaves it missing, and `recipes.lock` fills it in after parsing, so
 * this module never needs a provider.
 */
export const lockedRepoSchema = z.strictObject({
  url: repoUrlSchema,
  identity: repoIdentitySchema.optional(),
  indexHash: contentHashSchema.optional(),
});

/** A version of a recipe pinned for one holder alone. */
export const lockedPinSchema = z.strictObject({
  /** The exact version pinned for the holder. */
  version: semverVersionSchema,
  /** Content hash of that version, verified against the store after every fetch. */
  hash: contentHashSchema,
});

/** One locked recipe. */
export const lockedRecipeSchema = z.strictObject({
  /** The short name of the repo it came from; must appear under `repos`. */
  repo: repoNameSchema,
  /** The exact version resolved. */
  version: semverVersionSchema,
  /** Content hash of that version, verified against the store after every fetch. */
  hash: contentHashSchema,
  /**
   * Who holds this entry: `project` for a direct subscription, or the ref key of
   * a recipe that requires it. Used to refcount removal.
   */
  requestedBy: z
    .array(z.string().min(1, "must not be empty"))
    .min(1, "must name at least one holder"),
  /** Whether the holder relationship is a co-subscription or a build dependency. */
  kind: z.enum(LOCK_KINDS),
  /**
   * Versions pinned for one holder alone, keyed by the holder's recipe key: a
   * holder whose range does not allow `version`, of a recipe it reaches only
   * through `depends`.
   */
  pins: z.record(recipeKeySchema, lockedPinSchema).optional(),
});

/** The lockfile schema. */
export const lockfileSchema = z
  .strictObject({
    formatVersion: formatVersionSchema,
    /** Every repo the locked recipes came from, keyed by short name. */
    repos: z.record(repoNameSchema, lockedRepoSchema),
    /** Every locked recipe, keyed `namespace/recipe`. */
    recipes: z.record(recipeKeySchema, lockedRecipeSchema),
  })
  .superRefine((lock, ctx) => {
    // A recipe pointing at a repo the lockfile does not describe cannot be
    // restored, so name the pair rather than failing later at fetch time.
    for (const [key, entry] of Object.entries(lock.recipes)) {
      if (!Object.hasOwn(lock.repos, entry.repo)) {
        ctx.addIssue({
          code: "custom",
          path: ["recipes", key, "repo"],
          message:
            `names the repo '${entry.repo}', which this lockfile does not describe ` +
            `under 'repos'`,
        });
      }

      // A pin for a holder that does not hold the entry would outlive it.
      for (const holder of Object.keys(entry.pins ?? {})) {
        if (!entry.requestedBy.includes(holder)) {
          ctx.addIssue({
            code: "custom",
            path: ["recipes", key, "pins", holder],
            message: `pins a version for '${holder}', which is not listed in 'requestedBy'`,
          });
        }
      }
    }
  });

/** A validated lockfile. */
export type Lockfile = z.infer<typeof lockfileSchema>;

/** One locked repo entry. */
export type LockedRepo = z.infer<typeof lockedRepoSchema>;

/** One locked recipe entry. */
export type LockedRecipe = z.infer<typeof lockedRecipeSchema>;

/** A version pinned for one holder alone. */
export type LockedPin = z.infer<typeof lockedPinSchema>;

/** How a locked recipe entered the project. */
export type LockKind = DependencyKind;

/**
 * Validates a parsed lockfile, throwing a ConfigError that names the file and
 * the path of every bad field.
 *
 * @param value - The parsed contents of the lockfile.
 * @param sourceLabel - The lockfile's path, named in error messages.
 */
export function parseLockfile(value: unknown, sourceLabel: string): Lockfile {
  return parseFormat(lockfileSchema, value, sourceLabel, "lockfile");
}

/** An empty lockfile, for a project that has locked nothing yet. */
export function createEmptyLockfile(): Lockfile {
  return { formatVersion: 1, repos: {}, recipes: {} };
}

/**
 * Serializes a lockfile for writing, with every object key sorted so the
 * committed file changes only when its content genuinely does.
 *
 * @param lockfile - The lockfile to write.
 */
export function stringifyLockfile(lockfile: Lockfile): string {
  return stableJsonStringify(lockfile);
}
