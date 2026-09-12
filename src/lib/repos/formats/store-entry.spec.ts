import { describe, it, expect } from "vitest";
import {
  parseStoreEntry,
  storeEntryKey,
  storeEntrySchema,
  stringifyStoreEntry,
} from "./store-entry.js";
import { isConfigError } from "../../errors.js";

/**
 * Unit tests for the store entry marker (`.sous.entry.json`), which makes a
 * cached recipe version self-describing for verification and collection.
 */

const SOURCE =
  "/home/me/.sous/cache/github.com/sous-io/sous-recipes/workflow/task-files/1.2.0/.sous.entry.json";
const HASH = `sha256-${"c".repeat(64)}`;

/** A valid marker, used as the base for rejection cases. */
function validEntry() {
  return {
    formatVersion: 1,
    repo: "github.com/sous-io/sous-recipes",
    namespace: "workflow",
    name: "task-files",
    version: "1.2.0",
    hash: HASH,
    fetchedAt: "2026-09-01T10:00:00.000Z",
    lastAccessAt: "2026-09-09T14:03:11.482Z",
    sizeBytes: 20480,
  };
}

/** Runs parseStoreEntry and returns the ConfigError message, or fails. */
function expectRejectMessage(value: unknown): string {
  try {
    parseStoreEntry(value, SOURCE);
  } catch (error) {
    expect(isConfigError(error)).toBe(true);
    return (error as Error).message;
  }
  throw new Error("expected parseStoreEntry to throw, but it returned");
}

describe("parseStoreEntry()", () => {
  /**
   * A complete marker parses and is returned intact.
   */
  it("should accept a marker using every field", () => {
    const entry = validEntry();
    expect(parseStoreEntry(entry, SOURCE)).toEqual(entry);
  });

  /**
   * Every field is required; the marker exists so the store can be swept
   * without consulting any project, which a partial marker would defeat.
   */
  it("should reject a marker missing any field", () => {
    for (const field of [
      "formatVersion",
      "repo",
      "namespace",
      "name",
      "version",
      "hash",
      "fetchedAt",
      "lastAccessAt",
      "sizeBytes",
    ]) {
      const entry = validEntry() as Record<string, unknown>;
      delete entry[field];
      expect(expectRejectMessage(entry)).toContain(field);
    }
  });

  /**
   * The marker is machine-written, so an unknown key is a bug.
   */
  it("should reject an unknown key", () => {
    const message = expectRejectMessage({ ...validEntry(), verified: true });
    expect(message).toContain(`Invalid store entry marker at ${SOURCE}:`);
    expect(message).toContain("unknown key 'verified'");
  });

  /**
   * A size must be a whole, non-negative byte count.
   */
  it("should reject a negative or fractional size", () => {
    expect(expectRejectMessage({ ...validEntry(), sizeBytes: -1 })).toContain("sizeBytes:");
    expect(expectRejectMessage({ ...validEntry(), sizeBytes: 1.5 })).toContain("sizeBytes:");
  });

  /**
   * Timestamps carry an offset, so least-recently-used comparisons across
   * machines are unambiguous.
   */
  it("should reject a timestamp with no offset", () => {
    expect(expectRejectMessage({ ...validEntry(), lastAccessAt: "2026-09-09" })).toContain(
      "lastAccessAt: must be an ISO 8601 timestamp"
    );
  });
});

describe("storeEntryKey()", () => {
  /**
   * storeEntryKey rebuilds the recipe key the lockfile and index use.
   *
   * storeEntryKey(entry);  // -> "workflow/task-files"
   */
  it("should compose the namespace and name", () => {
    expect(storeEntryKey(parseStoreEntry(validEntry(), SOURCE))).toBe("workflow/task-files");
  });
});

describe("stringifyStoreEntry()", () => {
  /**
   * The marker is written with sorted keys and a trailing newline, and round
   * trips through JSON.parse.
   */
  it("should write sorted, round-trippable JSON", () => {
    const entry = parseStoreEntry(validEntry(), SOURCE);
    const text = stringifyStoreEntry(entry);
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(entry);
  });
});

describe("storeEntrySchema", () => {
  /**
   * The schema is exported for callers that want zod's safeParse result.
   */
  it("should be usable directly through safeParse", () => {
    expect(storeEntrySchema.safeParse(validEntry()).success).toBe(true);
    expect(storeEntrySchema.safeParse({}).success).toBe(false);
  });
});
