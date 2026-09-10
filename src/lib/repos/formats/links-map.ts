/**
 * The links map: `sous.links.json`.
 *
 * A link redirects a repo's resolution away from the store and at a real
 * working copy on disk, which is how a maintainer edits recipes: edits happen
 * in a checkout, never in the store. `sous repo link` writes an entry;
 * `sous repo unlink` removes it and leaves the checkout in place.
 *
 * Two maps are read: the project's `.sous/sous.links.json` and the machine-wide
 * `$SOUS_HOME/sous.links.json`, with the project map winning on conflict. The
 * file is MACHINE-WRITTEN and machine-local; it is never committed, because a
 * link bypasses versions, the lockfile and freshness checks, and those bypasses
 * belong to one person's machine rather than to the team.
 */

import { z } from "zod";
import {
  absolutePathSchema,
  formatVersionSchema,
  isoTimestampSchema,
  parseFormat,
  repoNameSchema,
  stableJsonStringify,
} from "./common.js";

/** How the linked working copy came to exist. */
export const LINK_ORIGINS = ["clone", "path"] as const;

/** One linked repo. */
export const repoLinkSchema = z.strictObject({
  /** Absolute path to the working copy sous reads instead of the store. */
  path: absolutePathSchema,
  /** When the link was created. */
  linkedAt: isoTimestampSchema,
  /**
   * Whether sous cloned the working copy itself ('clone') or was pointed at an
   * existing checkout ('path'). Unlinking never deletes either, but the origin
   * tells the user what sous put there.
   */
  origin: z.enum(LINK_ORIGINS),
});

/** The links map schema. */
export const linksMapSchema = z.strictObject({
  formatVersion: formatVersionSchema,
  /** Every linked repo, keyed by the repo's configured short name. */
  links: z.record(repoNameSchema, repoLinkSchema),
});

/** A validated links map. */
export type LinksMap = z.infer<typeof linksMapSchema>;

/** One validated link entry. */
export type RepoLink = z.infer<typeof repoLinkSchema>;

/** How the linked working copy came to exist. */
export type LinkOrigin = (typeof LINK_ORIGINS)[number];

/**
 * Validates a parsed links map, throwing a ConfigError that names the file and
 * the path of every bad field.
 *
 * @param value - The parsed contents of the links file.
 * @param sourceLabel - The links file's path, named in error messages.
 */
export function parseLinksMap(value: unknown, sourceLabel: string): LinksMap {
  return parseFormat(linksMapSchema, value, sourceLabel, "links map");
}

/** An empty links map, for a project or machine with nothing linked. */
export function createEmptyLinksMap(): LinksMap {
  return { formatVersion: 1, links: {} };
}

/**
 * Serializes a links map for writing, with keys sorted.
 *
 * @param map - The links map to write.
 */
export function stringifyLinksMap(map: LinksMap): string {
  return stableJsonStringify(map);
}

/**
 * Merges a machine-wide links map with a project's, with the project's entries
 * winning, which is the precedence `sous repo link` documents.
 *
 * @param global - The machine-wide map, or undefined when there is none.
 * @param project - The project's map, or undefined when there is none.
 */
export function mergeLinksMaps(
  global: LinksMap | undefined,
  project: LinksMap | undefined
): Record<string, RepoLink> {
  return { ...(global?.links ?? {}), ...(project?.links ?? {}) };
}
