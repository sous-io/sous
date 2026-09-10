/**
 * Unit tests for the freshness window and the always-pull lookup.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_FRESHNESS_SECONDS,
  findNewerInRange,
  recordUpstreamCheck,
  shouldCheckUpstream,
  type UpstreamCheckRecord,
} from "./freshness.js";
import type { IndexMeta } from "./providers/index-cache.js";
import { makeIndexFile } from "../../test/utils/repo-fixtures.js";

/** An in-memory stand-in for the index cache's sidecar. */
function memoryRecord(initial: Record<string, IndexMeta> = {}): UpstreamCheckRecord & {
  entries: Record<string, IndexMeta>;
} {
  const entries = { ...initial };
  return {
    entries,
    readMeta: (repoName) => entries[repoName],
    writeMeta: (repoName, meta) => {
      entries[repoName] = meta;
    },
  };
}

const NOON = new Date("2026-01-01T12:00:00.000Z");

describe("shouldCheckUpstream()", () => {
  /**
   * A repository sous has never checked is always checked.
   *
   * shouldCheckUpstream({}) // -> true
   */
  it("should check when there is no record of a previous check", () => {
    expect(shouldCheckUpstream({})).toBe(true);
  });

  /**
   * Inside the window there is nothing to gain from asking again.
   */
  it("should not check again inside the freshness window", () => {
    expect(
      shouldCheckUpstream({
        lastCheckedAt: "2026-01-01T11:58:00.000Z",
        freshnessSeconds: DEFAULT_FRESHNESS_SECONDS,
        now: NOON,
      })
    ).toBe(false);
  });

  /**
   * Once the window has lapsed, sous asks again.
   */
  it("should check once the freshness window has lapsed", () => {
    expect(
      shouldCheckUpstream({
        lastCheckedAt: "2026-01-01T11:50:00.000Z",
        freshnessSeconds: DEFAULT_FRESHNESS_SECONDS,
        now: NOON,
      })
    ).toBe(true);
  });

  /**
   * A zero-second window means "always check", which is what an explicit update
   * asks for, and `force` says the same thing outright.
   */
  it("should always check with a zero window or with force", () => {
    expect(
      shouldCheckUpstream({ lastCheckedAt: NOON.toISOString(), freshnessSeconds: 0, now: NOON })
    ).toBe(true);
    expect(
      shouldCheckUpstream({ lastCheckedAt: NOON.toISOString(), force: true, now: NOON })
    ).toBe(true);
  });

  /**
   * A last-check time that is unreadable, or in the future because a clock
   * changed, is not something to trust: check.
   */
  it("should check when the recorded time is unusable", () => {
    expect(shouldCheckUpstream({ lastCheckedAt: "not a date", now: NOON })).toBe(true);
    expect(
      shouldCheckUpstream({ lastCheckedAt: "2026-01-02T00:00:00.000Z", now: NOON })
    ).toBe(true);
  });
});

describe("recordUpstreamCheck()", () => {
  /**
   * Recording a check updates only the last-checked time, leaving the record of
   * when the index itself was fetched intact.
   *
   * recordUpstreamCheck(cache, "sous-recipes", now)
   * // -> { fetchedAt: <unchanged>, lastCheckedAt: <now> }
   */
  it("should update the last-checked time and keep the fetch record", () => {
    const record = memoryRecord({
      "sous-recipes": { fetchedAt: "2026-01-01T09:00:00.000Z", etag: 'W/"1"' },
    });

    const meta = recordUpstreamCheck(record, "sous-recipes", NOON);

    expect(meta).toEqual({
      fetchedAt: "2026-01-01T09:00:00.000Z",
      etag: 'W/"1"',
      lastCheckedAt: "2026-01-01T12:00:00.000Z",
    });
    expect(record.entries["sous-recipes"]).toEqual(meta);
  });

  /**
   * A check against a repository with no record at all still records the check,
   * which is what stops an unreachable host from being retried every build.
   */
  it("should record a check even when nothing was cached before", () => {
    const record = memoryRecord();

    recordUpstreamCheck(record, "sous-recipes", NOON);

    expect(record.entries["sous-recipes"]).toEqual({
      fetchedAt: "2026-01-01T12:00:00.000Z",
      lastCheckedAt: "2026-01-01T12:00:00.000Z",
    });
  });
});

describe("findNewerInRange()", () => {
  const index = makeIndexFile("sous-recipes", {
    "workflow/task-files": ["1.0.0", "1.4.0", "2.0.0", "2.1.0-beta.1"],
  });

  /**
   * Always-pull re-resolves within the declared range and never widens it: with
   * a caret-one range, version two is not an upgrade.
   *
   * findNewerInRange({ index, key, lockedVersion: "1.0.0", range: "^1.0.0" })
   * // -> { from: "1.0.0", to: "1.4.0" }
   */
  it("should find the newest version inside the declared range", () => {
    expect(
      findNewerInRange({
        index,
        key: "workflow/task-files",
        lockedVersion: "1.0.0",
        range: "^1.0.0",
      })
    ).toEqual({ key: "workflow/task-files", from: "1.0.0", to: "1.4.0" });
  });

  /**
   * When the locked version is already the best the range allows, there is
   * nothing to do.
   */
  it("should return undefined when the locked version is already the best", () => {
    expect(
      findNewerInRange({
        index,
        key: "workflow/task-files",
        lockedVersion: "1.4.0",
        range: "^1.0.0",
      })
    ).toBeUndefined();
  });

  /**
   * Prereleases stay out unless they were opted into.
   */
  it("should ignore prereleases unless they are opted into", () => {
    expect(
      findNewerInRange({ index, key: "workflow/task-files", lockedVersion: "2.0.0" })
    ).toBeUndefined();
    expect(
      findNewerInRange({
        index,
        key: "workflow/task-files",
        lockedVersion: "2.0.0",
        prerelease: true,
      })
    ).toEqual({ key: "workflow/task-files", from: "2.0.0", to: "2.1.0-beta.1" });
  });

  /**
   * A recipe the index does not publish at all yields nothing, since a failed
   * or empty check must never break a build.
   */
  it("should return undefined for a recipe the index does not publish", () => {
    expect(
      findNewerInRange({ index, key: "quality/reviews", lockedVersion: "1.0.0" })
    ).toBeUndefined();
  });
});
