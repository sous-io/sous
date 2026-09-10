import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isConfigError } from "../../errors.js";
import { makeTmpDir, type TmpDir } from "../../../test/utils/tmp.js";
import { hashDirectory } from "./hash.js";
import { RecipeStore, formatStoreKey } from "./recipe-store.js";
import type { StoreKey } from "./contract.js";

const tmpDirs: TmpDir[] = [];

/** Creates a temp dir that is cleaned up after the test. */
function tmp(): string {
  const dir = makeTmpDir("sous-store-");
  tmpDirs.push(dir);
  return dir.path;
}

/** Writes a file inside `root`, creating parent directories as needed. */
function write(root: string, relative: string, contents: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

/** Builds a source directory holding a small recipe. */
function makeSource(contents = "alpha"): string {
  const dir = tmp();
  write(dir, "SKILL.md", contents);
  write(dir, "references/detail.md", "detail");
  return dir;
}

/** A store rooted in a fresh temp directory, with warnings collected. */
function makeStore(): { store: RecipeStore; warnings: string[]; root: string } {
  const root = path.join(tmp(), "cache");
  const warnings: string[] = [];
  const store = new RecipeStore({ root, onWarning: (message) => warnings.push(message) });
  return { store, warnings, root };
}

const key: StoreKey = {
  repo: "sous-recipes",
  namespace: "workflow",
  name: "task-files",
  version: "1.2.0",
};

afterEach(() => {
  while (tmpDirs.length > 0) tmpDirs.pop()!.cleanup();
});

describe("RecipeStore", () => {
  describe("entryDir()", () => {
    /**
     * entryDir should lay an entry out as
     * `<root>/<repo>/<namespace>/<name>/<version>`, whether or not it exists.
     *
     * store.entryDir({ repo: "r", namespace: "n", name: "x", version: "1.0.0" });
     * // -> "<root>/r/n/x/1.0.0"
     */
    it("should return the decision 11 layout", () => {
      const { store, root } = makeStore();
      expect(store.entryDir(key)).toBe(
        path.join(root, "sous-recipes", "workflow", "task-files", "1.2.0")
      );
    });

    /**
     * entryDir should reject a key component that is not a single path
     * segment, so nothing can be written outside the store root.
     *
     * store.entryDir({ ...key, namespace: ".." });
     * // throws ConfigError
     */
    it("should reject a key component that could escape the root", () => {
      const { store } = makeStore();
      expect(() => store.entryDir({ ...key, namespace: ".." })).toThrow(/not a usable/);
      expect(() => store.entryDir({ ...key, name: "a/b" })).toThrow(/not a usable/);
    });
  });

  describe("put()", () => {
    /**
     * put should copy the source tree into the entry directory, write the
     * marker beside it, and return the marker it wrote.
     */
    it("should copy the files in and write the marker", async () => {
      const { store } = makeStore();
      const entry = await store.put(key, makeSource());
      const dir = store.entryDir(key);

      expect(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8")).toBe("alpha");
      expect(fs.readFileSync(path.join(dir, "references/detail.md"), "utf8")).toBe("detail");
      expect(entry.hash).toBe(await hashDirectory(dir));
      expect(entry.repo).toBe(key.repo);
      expect(entry.version).toBe("1.2.0");

      const marker = JSON.parse(
        fs.readFileSync(path.join(dir, ".sous.entry.json"), "utf8")
      );
      expect(marker.hash).toBe(entry.hash);
    });

    /**
     * put should record the total content size at write time, so the store can
     * be capped without rescanning it.
     */
    it("should record sizeBytes from the copied content", async () => {
      const { store } = makeStore();
      const entry = await store.put(key, makeSource());
      expect(entry.sizeBytes).toBe("alpha".length + "detail".length);
    });

    /**
     * put should accept content whose hash matches the caller's expectation.
     */
    it("should accept content matching the expected hash", async () => {
      const { store } = makeStore();
      const source = makeSource();
      const expected = await hashDirectory(source);

      const entry = await store.put(key, source, expected);
      expect(entry.hash).toBe(expected);
    });

    /**
     * put should refuse content that does not match the expected hash, name
     * both hashes and the key, and leave nothing behind.
     */
    it("should reject a hash mismatch and write nothing", async () => {
      const { store } = makeStore();
      const bogus = `sha256-${"0".repeat(64)}`;

      await expect(store.put(key, makeSource(), bogus)).rejects.toThrow(
        new RegExp(formatStoreKey(key).replace(/[/@:]/g, "."))
      );
      expect(fs.existsSync(store.entryDir(key))).toBe(false);

      // The staging directory is gone too, so a failed put leaves no debris.
      const parent = path.dirname(store.entryDir(key));
      expect(fs.existsSync(parent) ? fs.readdirSync(parent) : []).toEqual([]);
    });

    /**
     * put should raise a ConfigError (never a bare Error) on a hash mismatch,
     * so the command layer renders it as a config error block.
     */
    it("should raise a ConfigError on a hash mismatch", async () => {
      const { store } = makeStore();
      const error = await store
        .put(key, makeSource(), `sha256-${"0".repeat(64)}`)
        .catch((thrown) => thrown);
      expect(isConfigError(error)).toBe(true);
    });

    /**
     * put should allow re-storing an entry whose content is identical, since
     * that is a no-op restore rather than a republished version.
     */
    it("should allow replacing an entry with identical content", async () => {
      const { store } = makeStore();
      const first = await store.put(key, makeSource());
      const second = await store.put(key, makeSource());

      expect(second.hash).toBe(first.hash);
      expect(second.fetchedAt).toBe(first.fetchedAt);
    });

    /**
     * put should refuse to overwrite a stored version with different content,
     * because a published version is immutable.
     */
    it("should refuse to overwrite an entry with different content", async () => {
      const { store } = makeStore();
      await store.put(key, makeSource("alpha"));

      await expect(store.put(key, makeSource("changed"))).rejects.toThrow(
        /already holds/
      );
      expect(
        fs.readFileSync(path.join(store.entryDir(key), "SKILL.md"), "utf8")
      ).toBe("alpha");
    });

    /**
     * A symlink in the source is skipped whole, exactly as the content hash
     * skips it, so what lands in the store is what the hash was computed over.
     * Copying through a link would put bytes the repository does not own into
     * the store and make the entry differ from machine to machine.
     *
     * // source holds alias.md -> SKILL.md
     * put(key, source);  // -> the store has SKILL.md and no alias.md
     */
    it("should skip symlinks rather than storing what they point at", async () => {
      const { store } = makeStore();
      const source = makeSource();
      fs.symlinkSync(path.join(source, "SKILL.md"), path.join(source, "alias.md"));

      await store.put(key, source);
      expect(fs.existsSync(path.join(store.entryDir(key), "alias.md"))).toBe(false);
      expect(
        fs.readFileSync(path.join(store.entryDir(key), "SKILL.md"), "utf8")
      ).toBe("alpha");
    });

    /**
     * put should not copy a source `.git` directory into the store.
     */
    it("should skip a .git directory in the source", async () => {
      const { store } = makeStore();
      const source = makeSource();
      write(source, ".git/HEAD", "ref: refs/heads/main\n");

      await store.put(key, source);
      expect(fs.existsSync(path.join(store.entryDir(key), ".git"))).toBe(false);
    });
  });

  describe("get()", () => {
    /**
     * get should return the entry directory and its verified marker.
     */
    it("should return the directory and marker for a stored entry", async () => {
      const { store } = makeStore();
      const written = await store.put(key, makeSource());

      const hit = await store.get(key);
      expect(hit?.dir).toBe(store.entryDir(key));
      expect(hit?.entry.hash).toBe(written.hash);
    });

    /**
     * get should return undefined for an entry that was never stored.
     */
    it("should return undefined when the entry is absent", async () => {
      const { store } = makeStore();
      expect(await store.get(key)).toBeUndefined();
    });

    /**
     * get should update lastAccessAt and persist it, so collection sees the
     * use, while leaving the content untouched.
     */
    it("should touch lastAccessAt without changing the content", async () => {
      const { store } = makeStore();
      const written = await store.put(key, makeSource());
      const contentBefore = fs.readFileSync(
        path.join(store.entryDir(key), "SKILL.md"),
        "utf8"
      );

      await new Promise((resolve) => setTimeout(resolve, 5));
      const hit = await store.get(key);

      expect(hit?.entry.lastAccessAt >= written.lastAccessAt).toBe(true);
      const persisted = JSON.parse(
        fs.readFileSync(path.join(store.entryDir(key), ".sous.entry.json"), "utf8")
      );
      expect(persisted.lastAccessAt).toBe(hit?.entry.lastAccessAt);
      expect(
        fs.readFileSync(path.join(store.entryDir(key), "SKILL.md"), "utf8")
      ).toBe(contentBefore);
    });

    /**
     * get should treat an entry whose content no longer matches its marker as
     * absent, remove it, and say so through the warning sink.
     */
    it("should remove a corrupted entry and report it as absent", async () => {
      const { store, warnings } = makeStore();
      await store.put(key, makeSource());
      write(store.entryDir(key), "SKILL.md", "tampered");

      expect(await store.get(key)).toBeUndefined();
      expect(fs.existsSync(store.entryDir(key))).toBe(false);
      expect(warnings.join("\n")).toMatch(/did not match its recorded content hash/);
    });

    /**
     * get should treat an unreadable marker as absent and warn, so a damaged
     * store heals on the next fetch.
     */
    it("should treat an invalid marker as absent", async () => {
      const { store, warnings } = makeStore();
      await store.put(key, makeSource());
      write(store.entryDir(key), ".sous.entry.json", "{ not json");

      expect(await store.get(key)).toBeUndefined();
      expect(warnings.join("\n")).toMatch(/could not be read/);
    });
  });

  describe("has()", () => {
    /**
     * has should report presence of a readable marker.
     *
     * await store.has(key); // -> false, then true after put()
     */
    it("should report whether an entry is present", async () => {
      const { store } = makeStore();
      expect(await store.has(key)).toBe(false);
      await store.put(key, makeSource());
      expect(await store.has(key)).toBe(true);
    });
  });

  describe("remove()", () => {
    /**
     * remove should delete the entry and any directories its removal empties,
     * while leaving the store root in place.
     */
    it("should delete the entry and prune the empty parents", async () => {
      const { store, root } = makeStore();
      await store.put(key, makeSource());

      await store.remove(key);
      expect(fs.existsSync(store.entryDir(key))).toBe(false);
      expect(fs.existsSync(path.join(root, "sous-recipes"))).toBe(false);
      expect(fs.existsSync(root)).toBe(true);
    });

    /**
     * remove should keep a sibling version that is still stored.
     */
    it("should keep sibling versions", async () => {
      const { store } = makeStore();
      await store.put(key, makeSource("alpha"));
      const other = { ...key, version: "1.3.0" };
      await store.put(other, makeSource("beta"));

      await store.remove(key);
      expect(await store.has(other)).toBe(true);
    });

    /**
     * remove should be silent about an entry that is not there.
     */
    it("should do nothing for an absent entry", async () => {
      const { store } = makeStore();
      await expect(store.remove(key)).resolves.toBeUndefined();
    });
  });

  describe("list()", () => {
    /**
     * list should return one marker per stored entry, found by walking the
     * layout rather than by consulting any project.
     */
    it("should return every stored entry", async () => {
      const { store } = makeStore();
      await store.put(key, makeSource("alpha"));
      await store.put({ ...key, version: "1.3.0" }, makeSource("beta"));
      await store.put({ ...key, namespace: "tool-usage", name: "browsers" }, makeSource("c"));

      const listed = await store.list();
      expect(listed.map(formatStoreKey).sort()).toEqual([
        "sous-recipes:tool-usage/browsers@1.2.0",
        "sous-recipes:workflow/task-files@1.2.0",
        "sous-recipes:workflow/task-files@1.3.0",
      ]);
    });

    /**
     * list should return an empty array when the store root does not exist yet.
     */
    it("should return an empty array for an unused store", async () => {
      const { store } = makeStore();
      expect(await store.list()).toEqual([]);
    });
  });

  describe("gc()", () => {
    /** Stores an entry and forces its last-access time, oldest first. */
    async function seed(store: RecipeStore, version: string, lastAccessAt: string) {
      const entryKey = { ...key, version };
      await store.put(entryKey, makeSource(`body-${version}`));
      const markerPath = path.join(store.entryDir(entryKey), ".sous.entry.json");
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
      marker.lastAccessAt = lastAccessAt;
      fs.writeFileSync(markerPath, JSON.stringify(marker));
      return entryKey;
    }

    /**
     * gc should evict least-recently-used entries until the store fits inside
     * the cap, and report what it did.
     */
    it("should evict the least recently used entries first", async () => {
      const { store } = makeStore();
      const oldest = await seed(store, "1.0.0", "2026-01-01T00:00:00.000Z");
      const newest = await seed(store, "1.1.0", "2026-06-01T00:00:00.000Z");
      const perEntry = (await store.list())[0].sizeBytes;

      const report = await store.gc({ maxBytes: perEntry });
      expect(report.evicted.map((entry) => entry.version)).toEqual(["1.0.0"]);
      expect(report.bytesBefore).toBe(perEntry * 2);
      expect(report.bytesAfter).toBe(perEntry);
      expect(await store.has(oldest)).toBe(false);
      expect(await store.has(newest)).toBe(true);
    });

    /**
     * gc should never evict a key the caller asked to keep, even when that
     * leaves the store above its cap.
     */
    it("should never evict a kept key", async () => {
      const { store } = makeStore();
      const oldest = await seed(store, "1.0.0", "2026-01-01T00:00:00.000Z");
      await seed(store, "1.1.0", "2026-06-01T00:00:00.000Z");

      const report = await store.gc({ maxBytes: 1, keep: [oldest] });
      expect(report.evicted.map((entry) => entry.version)).toEqual(["1.1.0"]);
      expect(await store.has(oldest)).toBe(true);
    });

    /**
     * gc should evict nothing when the store already fits.
     */
    it("should evict nothing when the store is under the cap", async () => {
      const { store } = makeStore();
      await seed(store, "1.0.0", "2026-01-01T00:00:00.000Z");

      const report = await store.gc({ maxBytes: 1024 * 1024 });
      expect(report.evicted).toEqual([]);
      expect(report.kept).toHaveLength(1);
      expect(report.bytesAfter).toBe(report.bytesBefore);
    });

    /**
     * gc should report what it would evict without touching the store when
     * dryRun is set.
     */
    it("should leave everything in place for a dry run", async () => {
      const { store } = makeStore();
      const oldest = await seed(store, "1.0.0", "2026-01-01T00:00:00.000Z");
      await seed(store, "1.1.0", "2026-06-01T00:00:00.000Z");
      const perEntry = (await store.list())[0].sizeBytes;

      const report = await store.gc({ maxBytes: perEntry, dryRun: true });
      expect(report.evicted.map((entry) => entry.version)).toEqual(["1.0.0"]);
      expect(await store.has(oldest)).toBe(true);
    });
  });

  describe("fromEnv()", () => {
    /**
     * fromEnv should root the store at `$SOUS_HOME/cache`, resolved from the
     * environment at call time.
     *
     * RecipeStore.fromEnv({ SOUS_HOME: "/opt/sous-home" }).root;
     * // -> "/opt/sous-home/cache"
     */
    it("should root the store at the user-level cache directory", () => {
      const store = RecipeStore.fromEnv({ SOUS_HOME: "/opt/sous-home" });
      expect(store.root).toBe(path.join("/opt/sous-home", "cache"));
    });
  });
});
