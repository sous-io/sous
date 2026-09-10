/**
 * The store's tunable numbers, read from the optional top-level `store:` block
 * of a project's config.
 *
 * Every value sous ships is a DEFAULT, not an assumption: the schema
 * (`config-schema.ts`) makes each field optional and this module supplies the
 * fallback, so a project can change any of them without having to restate the
 * others.
 */

import type { Settings } from "../../settings.js";

/**
 * Default size cap for the whole store: one gigabyte. Past this, `gc()` evicts
 * least-recently-used entries that no lockfile pins.
 */
export const DEFAULT_STORE_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * Default freshness window for a fetched repo index: five minutes. A non-watch
 * build re-checks upstream only once this window has lapsed, and a failed check
 * never breaks a build; the last good answer stands.
 */
export const DEFAULT_FRESHNESS_SECONDS = 300;

/**
 * Default interval at which watch mode polls upstream for a newer in-range
 * version: five minutes.
 */
export const DEFAULT_WATCH_POLL_SECONDS = 300;

/** The store's settings, with every default applied. */
export type ResolvedStoreSettings = {
  /** Size cap for the whole store, in bytes. */
  maxBytes: number;
  /** How long a fetched index stays fresh, in seconds. */
  freshnessSeconds: number;
  /** How often watch mode polls upstream, in seconds. */
  watchPollSeconds: number;
};

/**
 * Resolves the store settings for a project: the `store:` block if it has one,
 * with sous's defaults filling every field it leaves out.
 *
 * The values are plain numbers rather than `${var}` strings, so no variable
 * resolution is involved and this can be called with the raw merged settings.
 *
 * @param settings - The merged, validated project config.
 */
export function resolveStoreSettings(settings: Settings): ResolvedStoreSettings {
  const store = settings.store ?? {};
  return {
    maxBytes: store.maxBytes ?? DEFAULT_STORE_MAX_BYTES,
    freshnessSeconds: store.freshnessSeconds ?? DEFAULT_FRESHNESS_SECONDS,
    watchPollSeconds: store.watchPollSeconds ?? DEFAULT_WATCH_POLL_SECONDS,
  };
}
