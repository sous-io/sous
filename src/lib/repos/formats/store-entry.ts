/**
 * The store entry marker: `.sous.entry.json`, written beside every cached
 * recipe version in the machine-wide store
 * (`$SOUS_HOME/cache/<repo>/<namespace>/<recipe>/<version>/`).
 *
 * The marker is MACHINE-WRITTEN and makes an entry self-describing, so the
 * store can be swept without consulting any project: `hash` is checked against
 * the lockfile before the entry is used, `sizeBytes` and `lastAccessAt` drive
 * the size-capped least-recently-used collection that `sous repo gc` performs.
 *
 * The store is disposable by design; everything in it is re-fetchable from the
 * pins in a project's lockfile.
 */

import { z } from "zod";
import {
  byteCountSchema,
  contentHashSchema,
  formatVersionSchema,
  isoTimestampSchema,
  namespaceNameSchema,
  parseFormat,
  recipeNameSchema,
  repoNameSchema,
  semverVersionSchema,
  stableJsonStringify,
} from "./common.js";

/** The store entry marker schema. */
export const storeEntrySchema = z.strictObject({
  formatVersion: formatVersionSchema,
  /** Short name of the repo the recipe came from. */
  repo: repoNameSchema,
  /** The recipe's namespace. */
  namespace: namespaceNameSchema,
  /** The recipe's name. */
  name: recipeNameSchema,
  /** The exact version cached here. */
  version: semverVersionSchema,
  /** Content hash of the cached files, verified before the entry is used. */
  hash: contentHashSchema,
  /** When the entry was fetched. */
  fetchedAt: isoTimestampSchema,
  /** When the entry was last read by a build. Drives least-recently-used collection. */
  lastAccessAt: isoTimestampSchema,
  /** Total size of the entry's files, so the store can be capped without a rescan. */
  sizeBytes: byteCountSchema,
});

/** A validated store entry marker. */
export type StoreEntry = z.infer<typeof storeEntrySchema>;

/**
 * Validates a parsed store entry marker, throwing a ConfigError that names the
 * file and the path of every bad field.
 *
 * @param value - The parsed contents of the marker file.
 * @param sourceLabel - The marker's path, named in error messages.
 */
export function parseStoreEntry(value: unknown, sourceLabel: string): StoreEntry {
  return parseFormat(storeEntrySchema, value, sourceLabel, "store entry marker");
}

/**
 * Serializes a store entry marker for writing, with keys sorted.
 *
 * @param entry - The marker to write.
 */
export function stringifyStoreEntry(entry: StoreEntry): string {
  return stableJsonStringify(entry);
}

/**
 * The recipe key (`namespace/recipe`) a store entry holds.
 *
 * @param entry - A validated store entry marker.
 */
export function storeEntryKey(entry: StoreEntry): string {
  return `${entry.namespace}/${entry.name}`;
}
