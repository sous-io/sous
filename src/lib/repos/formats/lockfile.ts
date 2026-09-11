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
 */

import { z } from "zod";
import { repoIdentity } from "../identity.js";
import { requireProvider } from "../providers/index.js";
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
} from "./common.js";

/** The literal `requestedBy` holder meaning "the project subscribed to this directly". */
export const PROJECT_HOLDER = "project";

/** How a locked recipe entered the project. */
export const LOCK_KINDS = ["subscribes", "depends"] as const;

/** One repo the project resolves against. */
export const lockedRepoSchema = z
  .strictObject({
    /**
     * Where the repo lives, as recorded when it was added: a URL, or an absolute
     * path for a repository on this machine read through the `local` provider.
     */
    url: repoUrlSchema,
    /**
     * The repository's canonical identity, derived from that URL. The keys of
     * `repos` are the project's own short names, which no other project has to
     * agree with; this is what the machine-wide store and the index cache file
     * the repository under, so a restore finds the same cached copy every other
     * project uses.
     *
     * Optional ON READ only, for lockfiles written before the store was keyed by
     * identity: an entry without one has its identity derived from `url` below,
     * exactly as the writer would have derived it. Every lockfile sous writes
     * carries it, so the field fills itself in on the next write.
     */
    identity: repoIdentitySchema.optional(),
    /** Content hash of the index this lock was resolved against, when known. */
    indexHash: contentHashSchema.optional(),
  })
  .transform((entry, ctx) => {
    if (entry.identity !== undefined) return { ...entry, identity: entry.identity };

    // An older lockfile recorded only the URL. Deriving the identity through the
    // provider that handles that URL is what the writer itself does, so the
    // answer is the one the entry would have carried had it been written today.
    try {
      const identity = repoIdentity(requireProvider(entry.url).canonicalize(entry.url));
      return { ...entry, identity };
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["identity"],
        message:
          `is missing, and sous could not work one out from the url '${entry.url}' ` +
          `because no provider recognizes it. Add an 'identity' to this entry, or ` +
          `remove the lockfile and subscribe again to have sous rebuild it.`,
      });
      return z.NEVER;
    }
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
    }
  });

/** A validated lockfile. */
export type Lockfile = z.infer<typeof lockfileSchema>;

/** One locked repo entry. */
export type LockedRepo = z.infer<typeof lockedRepoSchema>;

/** One locked recipe entry. */
export type LockedRecipe = z.infer<typeof lockedRecipeSchema>;

/** How a locked recipe entered the project. */
export type LockKind = (typeof LOCK_KINDS)[number];

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
