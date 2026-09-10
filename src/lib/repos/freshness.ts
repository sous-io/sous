/**
 * Freshness: when sous bothers to look upstream.
 *
 * A build does not want to talk to the network on every run, and a lockfile
 * means it usually has no reason to. So the rule is deliberately dull: a
 * repository is checked when it has never been checked, when the freshness
 * window has lapsed since the last check, or when something asks to always
 * pull. Watch mode passes a shorter window; a one-off command can force it.
 *
 * The last-check time is remembered in the sidecar the index cache already
 * writes, so there is one record per repository rather than two.
 *
 * A failed check NEVER breaks a build. That belongs to the index cache, which
 * falls back to the copy it already holds; this module only decides whether to
 * look.
 */

import semver from "semver";
import type { IndexFile } from "./formats/index-file.js";
import type { IndexMeta } from "./providers/index-cache.js";

/** How long a check stays good when nothing says otherwise: five minutes. */
// The freshness default is shared with the store settings so there is one number.
import { DEFAULT_FRESHNESS_SECONDS } from "./store/settings.js";

/** The part of the index cache this module uses; IndexCache satisfies it. */
export type UpstreamCheckRecord = {
  readMeta(repoName: string): IndexMeta | undefined;
  writeMeta(repoName: string, meta: IndexMeta): void;
};

/** What decides whether to look upstream. */
export type FreshnessInput = {
  /** When sous last asked upstream, from the repository's sidecar. */
  lastCheckedAt?: string;
  /** How long a check stays good, in seconds. Defaults to five minutes. */
  freshnessSeconds?: number;
  /**
   * Whether something in play prefers a newer in-range version over the locked
   * one. Always-pull still respects the freshness window; it changes what
   * happens after the check, not how often the check happens.
   */
  alwaysPull?: boolean;
  /** Check regardless, which is what an explicit update command does. */
  force?: boolean;
  /** The clock. Defaults to now. */
  now?: Date;
};

/**
 * True when sous should ask upstream whether there is anything newer.
 *
 * shouldCheckUpstream({ lastCheckedAt: "2026-01-01T00:00:00.000Z", freshnessSeconds: 300 })
 * // -> false a minute later, true six minutes later
 *
 * @param input - The last check, the window, and the flags.
 */
export function shouldCheckUpstream(input: FreshnessInput): boolean {
  if (input.force === true) return true;
  if (input.lastCheckedAt === undefined) return true;

  const last = Date.parse(input.lastCheckedAt);
  if (Number.isNaN(last)) return true;

  const now = (input.now ?? new Date()).getTime();
  const windowSeconds = input.freshnessSeconds ?? DEFAULT_FRESHNESS_SECONDS;
  if (windowSeconds <= 0) return true;

  const ageSeconds = (now - last) / 1000;
  // A last-check time in the future means a clock changed under sous; check
  // rather than trusting an answer that cannot be right.
  if (ageSeconds < 0) return true;
  return ageSeconds >= windowSeconds;
}

/**
 * Records that sous just looked upstream for a repository, whether or not the
 * look succeeded. Recording a failed check too is what stops an unreachable
 * host from being retried on every single build.
 *
 * @param record - The index cache, or anything with its sidecar methods.
 * @param repoName - The repository's short name.
 * @param when - The moment to record. Defaults to now.
 */
export function recordUpstreamCheck(
  record: UpstreamCheckRecord,
  repoName: string,
  when: Date = new Date()
): IndexMeta {
  const existing = record.readMeta(repoName);
  const meta: IndexMeta = {
    fetchedAt: existing?.fetchedAt ?? when.toISOString(),
    ...(existing?.etag === undefined ? {} : { etag: existing.etag }),
    ...(existing?.ref === undefined ? {} : { ref: existing.ref }),
    lastCheckedAt: when.toISOString(),
  };
  record.writeMeta(repoName, meta);
  return meta;
}

/** What an always-pull check found. */
export type NewerVersion = {
  /** The recipe key. */
  key: string;
  /** The version currently locked. */
  from: string;
  /** The newer version that also satisfies the range. */
  to: string;
};

/**
 * Finds a newer in-range version of a locked recipe, or undefined when the
 * locked one is still the best the range allows. This is the whole of what
 * always-pull does: it re-resolves WITHIN the declared range and never widens
 * it, so a dependency's constraint still holds.
 *
 * @param options - The index, the recipe, its locked version and its range.
 */
export function findNewerInRange(options: {
  /** The repository's index. */
  index: IndexFile;
  /** The recipe key, `namespace/recipe`. */
  key: string;
  /** The version the lockfile pins. */
  lockedVersion: string;
  /** The range the subscription or dependency declared. Defaults to any version. */
  range?: string;
  /** Whether prereleases take part. */
  prerelease?: boolean;
}): NewerVersion | undefined {
  const entry = options.index.recipes[options.key];
  if (entry === undefined) return undefined;

  const prerelease = options.prerelease ?? false;
  const candidates = Object.keys(entry.versions).filter((version) => {
    if (!prerelease && entry.versions[version]!.prerelease === true) return false;
    return semver.satisfies(version, options.range ?? "*", { includePrerelease: prerelease });
  });

  const best = semver.maxSatisfying(candidates, "*", { includePrerelease: prerelease });
  if (best === null) return undefined;
  if (semver.lte(best, options.lockedVersion)) return undefined;

  return { key: options.key, from: options.lockedVersion, to: best };
}
