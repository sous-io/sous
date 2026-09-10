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

/** The holder meaning the project subscribed to a recipe itself. */
const PROJECT = "project";

/** Every range a locked recipe's holders declared, or nothing when one cannot be told. */
export type DeclaredRangeLookup = {
  /**
   * The range the project's subscription declares for a recipe key, `"*"` when
   * the subscription declares none, or undefined when the project holds nothing
   * matching it any more.
   */
  subscriptionRange(key: string): string | undefined;
  /**
   * The range one holding recipe's manifest declares for a dependency, `"*"`
   * when it declares none, or undefined when its manifest cannot be read or no
   * longer names that dependency.
   */
  dependencyRange(holder: string, key: string): string | undefined;
};

/**
 * The version range an always-pull check may move ONE locked recipe within, or
 * undefined when sous cannot tell and therefore must not move it at all.
 *
 * Always-pull re-resolves within what was declared; it never widens it. What was
 * declared depends on who holds the recipe. The project's own hold means the
 * subscription's range, which may genuinely be any version. A hold by another
 * recipe means the range that recipe's manifest declared in `depends`, and no
 * subscription anywhere carries it, so falling back to `*` for such an entry
 * would move it straight past the constraint the dependency declared. Several
 * holders mean every one of their ranges at once: whitespace between comparator
 * sets is AND in semver, which is exactly that.
 *
 * Returning undefined is the safe answer, and the entry stays where the lockfile
 * pins it. It happens when a holder's declaration cannot be read and when the
 * combined range is not one semver can express.
 *
 * @param key - The locked recipe key, `namespace/recipe`.
 * @param requestedBy - Its lockfile holders: "project", and any recipe keys.
 * @param lookup - How to read what each holder declared.
 */
export function effectiveRangeForHolders(
  key: string,
  requestedBy: readonly string[],
  lookup: DeclaredRangeLookup
): string | undefined {
  const ranges: string[] = [];

  for (const holder of requestedBy) {
    const declared =
      holder === PROJECT ? lookup.subscriptionRange(key) : lookup.dependencyRange(holder, key);
    if (declared === undefined) return undefined;
    ranges.push(declared);
  }

  if (ranges.length === 0) return undefined;

  const constraints = [...new Set(ranges.filter((range) => range !== "*"))];
  if (constraints.length === 0) return "*";

  const combined = constraints.join(" ");
  return semver.validRange(combined) === null ? undefined : combined;
}
