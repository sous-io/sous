/**
 * Unit tests for the lockfile service, including a restore against the
 * in-memory fake store and a stubbed provider. No network, no git.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LockService } from "./lock-service.js";
import { createEmptyLockfile, type Lockfile } from "./formats/lockfile.js";
import type { ResolvedRecipe } from "./resolver.js";
import type { CanonicalRepo, RepoProvider } from "./providers/provider.js";
import { makeTmpDir, type TmpDir } from "../../test/utils/tmp.js";
import { FakeRecipeStore } from "../../test/utils/fake-store.js";
import { fakeHash, makeIndexFile } from "../../test/utils/repo-fixtures.js";

/** Builds a resolved recipe with the fields the lockfile reads. */
function resolvedRecipe(
  key: string,
  version: string,
  overrides: Partial<ResolvedRecipe> = {}
): ResolvedRecipe {
  const namespace = key.slice(0, key.indexOf("/"));
  return {
    key,
    namespace,
    name: key.slice(namespace.length + 1),
    repo: "sous-recipes",
    version,
    hash: fakeHash(`sous-recipes/${key}@${version}`),
    tag: `${key}@${version}`,
    path: `recipes/${key}`,
    kind: "subscribes",
    requestedBy: ["project"],
    ranges: [{ range: "*", requestedBy: "project" }],
    prerelease: false,
    ...overrides,
  };
}

const REPOS = { "sous-recipes": { url: "https://github.com/sous-io/sous-recipes" } };

describe("LockService", () => {
  let tmp: TmpDir;
  let sousDir: string;
  let service: LockService;

  beforeEach(() => {
    tmp = makeTmpDir("sous-lock-");
    sousDir = path.join(tmp.path, ".sous");
    fs.mkdirSync(sousDir, { recursive: true });
    service = new LockService(sousDir);
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /**
   * A project that has locked nothing has no lockfile, and gets an empty one
   * rather than an error.
   *
   * read() // -> { formatVersion: 1, repos: {}, recipes: {} }
   */
  it("should read an empty lockfile when the file does not exist", () => {
    expect(service.read()).toEqual(createEmptyLockfile());
  });

  /**
   * write then read should round-trip, and the written file should have sorted
   * keys so the committed diff stays minimal.
   */
  it("should write a lockfile that reads back unchanged", () => {
    const lock = service.applyResolution(
      createEmptyLockfile(),
      [resolvedRecipe("workflow/task-files", "1.0.0")],
      REPOS
    );

    service.write(lock);

    expect(service.read()).toEqual(lock);
    expect(fs.readdirSync(sousDir)).toEqual(["sous.lock.json"]);
  });

  /**
   * applyResolution should record the version, hash, holders and kind of every
   * resolved recipe, and the repository each came from.
   */
  it("should record what a resolution settled on", () => {
    const lock = service.applyResolution(
      createEmptyLockfile(),
      [
        resolvedRecipe("workflow/task-files", "1.2.0"),
        resolvedRecipe("core/partials", "1.0.0", {
          kind: "depends",
          requestedBy: ["workflow/task-files"],
        }),
      ],
      REPOS
    );

    expect(Object.keys(lock.recipes)).toEqual(["core/partials", "workflow/task-files"]);
    expect(lock.recipes["core/partials"]).toMatchObject({
      repo: "sous-recipes",
      version: "1.0.0",
      kind: "depends",
      requestedBy: ["workflow/task-files"],
    });
    expect(lock.repos["sous-recipes"]).toEqual({
      url: "https://github.com/sous-io/sous-recipes",
    });
  });

  /**
   * A resolution that covers only part of the project carries the rest through
   * untouched, so installing one thing never drops another.
   */
  it("should carry through recipes a partial resolution did not mention", () => {
    const first = service.applyResolution(
      createEmptyLockfile(),
      [resolvedRecipe("workflow/task-files", "1.0.0")],
      REPOS
    );
    const second = service.applyResolution(
      first,
      [resolvedRecipe("quality/reviews", "1.0.0")],
      REPOS
    );

    expect(Object.keys(second.recipes)).toEqual(["quality/reviews", "workflow/task-files"]);
  });

  /**
   * removeHolder should refcount: a recipe two things hold survives losing one
   * of them, and a recipe nothing holds any more goes.
   */
  it("should drop only the recipes nobody holds any more", () => {
    const lock = service.applyResolution(
      createEmptyLockfile(),
      [
        resolvedRecipe("workflow/task-files", "1.0.0"),
        resolvedRecipe("core/partials", "1.0.0", {
          kind: "depends",
          requestedBy: ["project", "workflow/task-files"],
        }),
      ],
      REPOS
    );

    const after = service.removeHolder(lock, "workflow/task-files");

    expect(Object.keys(after.recipes)).toEqual(["core/partials", "workflow/task-files"]);
    expect(after.recipes["core/partials"]?.requestedBy).toEqual(["project"]);
  });

  /**
   * Removing a holder can orphan what it held, and that has to cascade: a
   * dependency held only by a removed recipe goes too.
   */
  it("should cascade a removal through what the removed recipe held", () => {
    const lock = service.applyResolution(
      createEmptyLockfile(),
      [
        resolvedRecipe("workflow/task-files", "1.0.0"),
        resolvedRecipe("core/partials", "1.0.0", {
          kind: "depends",
          requestedBy: ["workflow/task-files"],
        }),
      ],
      REPOS
    );

    const after = service.removeHolder(lock, "project");

    expect(after.recipes).toEqual({});
    expect(after.repos).toEqual({});
  });

  /**
   * diff should describe the change in plain language: additions, version
   * changes and removals, plus the repositories that came and went.
   */
  it("should describe the difference between two lockfiles in plain language", () => {
    const before = service.applyResolution(
      createEmptyLockfile(),
      [
        resolvedRecipe("workflow/task-files", "1.0.0"),
        resolvedRecipe("quality/reviews", "1.0.0"),
      ],
      REPOS
    );
    const after = service.applyResolution(
      service.removeHolder(before, "project"),
      [
        resolvedRecipe("workflow/task-files", "1.1.0"),
        resolvedRecipe("core/partials", "2.0.0"),
      ],
      REPOS
    );

    const diff = service.diff(before, after);

    expect(diff.unchanged).toBe(false);
    expect(diff.lines).toEqual([
      "Adding core/partials version 2.0.0",
      "Updating workflow/task-files from version 1.0.0 to version 1.1.0",
      "Removing quality/reviews, which nothing needs any more",
    ]);
  });

  /**
   * Two identical lockfiles differ in nothing, and the summary says so rather
   * than printing an empty list.
   */
  it("should say plainly when nothing changed", () => {
    const lock = service.applyResolution(
      createEmptyLockfile(),
      [resolvedRecipe("workflow/task-files", "1.0.0")],
      REPOS
    );

    expect(service.diff(lock, lock)).toMatchObject({ unchanged: true, lines: ["Nothing changed."] });
  });

  describe("restore()", () => {
    /** A provider that writes a file where a real fetch would put the recipe. */
    function stubProvider(fetched: string[]): RepoProvider {
      return {
        id: "github",
        features: ["fetch"],
        matches: () => true,
        canonicalize: (url: string): CanonicalRepo => ({
          host: "github.com",
          owner: "sous-io",
          name: "sous-recipes",
          httpsUrl: `${url}.git`,
          sshUrl: "git@github.com:sous-io/sous-recipes.git",
        }),
        fetchIndex: async () => ({ text: "{}", ref: "HEAD" }),
        fetchRecipeTree: async (_repo, recipePath, tag, destDir) => {
          fetched.push(`${recipePath}@${tag}`);
          fs.mkdirSync(destDir, { recursive: true });
          fs.writeFileSync(path.join(destDir, "SKILL.md"), "# a recipe\n", "utf8");
        },
      };
    }

    /**
     * A restore fetches every locked recipe the store does not already hold,
     * at the locked version's tag, and stores it under the locked hash.
     */
    it("should fetch what the store is missing, at the locked version", async () => {
      const lock = service.applyResolution(
        createEmptyLockfile(),
        [resolvedRecipe("workflow/task-files", "1.0.0")],
        REPOS
      );
      const store = new FakeRecipeStore({ root: path.join(tmp.path, "store") });
      fs.mkdirSync(store.root, { recursive: true });
      const fetched: string[] = [];

      const report = await service.restore(lock, {
        store,
        indexes: new Map([
          ["sous-recipes", makeIndexFile("sous-recipes", { "workflow/task-files": ["1.0.0"] })],
        ]),
        providers: [stubProvider(fetched)],
      });

      expect(report.restored).toEqual(["workflow/task-files"]);
      expect(fetched).toEqual(["recipes/workflow/task-files@workflow/task-files@1.0.0"]);
      expect(store.puts[0]?.expectedHash).toBe(lock.recipes["workflow/task-files"]?.hash);
    });

    /**
     * A recipe the store already holds, whose hash still verifies, is left
     * alone; a restore on a warm machine touches the network not at all.
     */
    it("should leave a verified entry the store already holds alone", async () => {
      const lock = service.applyResolution(
        createEmptyLockfile(),
        [resolvedRecipe("workflow/task-files", "1.0.0")],
        REPOS
      );
      const store = new FakeRecipeStore({ root: path.join(tmp.path, "store") });
      store.seed(
        { repo: "sous-recipes", namespace: "workflow", name: "task-files", version: "1.0.0" },
        lock.recipes["workflow/task-files"]!.hash
      );
      const fetched: string[] = [];

      const report = await service.restore(lock, {
        store,
        indexes: new Map([
          ["sous-recipes", makeIndexFile("sous-recipes", { "workflow/task-files": ["1.0.0"] })],
        ]),
        providers: [stubProvider(fetched)],
      });

      expect(report).toEqual({ restored: [], alreadyPresent: ["workflow/task-files"] });
      expect(fetched).toEqual([]);
    });

    /**
     * A locked version the index no longer offers cannot be restored, and the
     * error should name the recipe, the version and the repository.
     */
    it("should raise when the index no longer offers the locked version", async () => {
      const lock = service.applyResolution(
        createEmptyLockfile(),
        [resolvedRecipe("workflow/task-files", "9.9.9")],
        REPOS
      );
      const store = new FakeRecipeStore({ root: path.join(tmp.path, "store") });

      await expect(
        service.restore(lock, {
          store,
          indexes: new Map([
            ["sous-recipes", makeIndexFile("sous-recipes", { "workflow/task-files": ["1.0.0"] })],
          ]),
          providers: [stubProvider([])],
        })
      ).rejects.toThrow(/pins 'workflow\/task-files' at version 9\.9\.9/);
    });
  });
});
