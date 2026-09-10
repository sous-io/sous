import { describe, expect, it } from "vitest";
import { makeSettings } from "../../../test/utils/settings.js";
import {
  DEFAULT_FRESHNESS_SECONDS,
  DEFAULT_STORE_MAX_BYTES,
  DEFAULT_WATCH_POLL_SECONDS,
  resolveStoreSettings,
} from "./settings.js";

describe("resolveStoreSettings()", () => {
  /**
   * resolveStoreSettings should supply every default when a project declares no
   * `store:` block at all.
   *
   * resolveStoreSettings(makeSettings({}));
   * // -> { maxBytes: 1073741824, freshnessSeconds: 300, watchPollSeconds: 300 }
   */
  it("should return the shipped defaults when no store block is present", () => {
    expect(resolveStoreSettings(makeSettings({}))).toEqual({
      maxBytes: DEFAULT_STORE_MAX_BYTES,
      freshnessSeconds: DEFAULT_FRESHNESS_SECONDS,
      watchPollSeconds: DEFAULT_WATCH_POLL_SECONDS,
    });
  });

  /**
   * The shipped defaults should be one gigabyte and five minutes, the numbers
   * the configuration reference documents.
   */
  it("should ship one gigabyte and five-minute defaults", () => {
    expect(DEFAULT_STORE_MAX_BYTES).toBe(1073741824);
    expect(DEFAULT_FRESHNESS_SECONDS).toBe(300);
    expect(DEFAULT_WATCH_POLL_SECONDS).toBe(300);
  });

  /**
   * resolveStoreSettings should let a project override every value.
   *
   * resolveStoreSettings(makeSettings({ store: { maxBytes: 42 } })).maxBytes;
   * // -> 42
   */
  it("should let the config override every value", () => {
    const resolved = resolveStoreSettings(
      makeSettings({
        store: { maxBytes: 42, freshnessSeconds: 7, watchPollSeconds: 9 },
      })
    );
    expect(resolved).toEqual({ maxBytes: 42, freshnessSeconds: 7, watchPollSeconds: 9 });
  });

  /**
   * resolveStoreSettings should fill only the fields a partial block leaves
   * out, so changing one number never resets the others.
   */
  it("should apply defaults per field for a partial store block", () => {
    const resolved = resolveStoreSettings(makeSettings({ store: { freshnessSeconds: 0 } }));
    expect(resolved.freshnessSeconds).toBe(0);
    expect(resolved.maxBytes).toBe(DEFAULT_STORE_MAX_BYTES);
    expect(resolved.watchPollSeconds).toBe(DEFAULT_WATCH_POLL_SECONDS);
  });
});
