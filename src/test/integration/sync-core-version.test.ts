/**
 * `scripts/sync-core-version.mts`, the one thing that holds the packaged core
 * recipe at the sous package's own version.
 *
 * Version parity is a hard rule: every project's implicit `core` subscription
 * asks for exactly the running sous version, so a packaged recipe declaring
 * anything else is unresolvable the moment it is seeded. The release workflow
 * runs this script inside the commit that bumps `package.json`, so it is worth
 * running the real script, exactly the way the workflow runs it, against a
 * throwaway repository rather than importing its internals.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { hashDirectory } from "../../lib/repos/store/hash.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scriptPath = path.join(repoRoot, "scripts", "sync-core-version.mts");

/** Booting tsx and the module graph behind the script costs a few seconds. */
const SCRIPT_TIMEOUT = 60_000;

/** Where the packaged core recipe lives inside a sous repository. */
const CORE_DIR = path.join("recipes", "core", "sous-skills");

/** A manifest written the way a person writes one: comments, blank lines, a folded block. */
const MANIFEST = [
  "# core/sous-skills",
  "#",
  "# The offline seed that ships inside the package.",
  "formatVersion: 1",
  "",
  "namespace: core",
  "name: sous-skills",
  "version: 0.1.1",
  "",
  "description: >-",
  "  The skills that teach an agent what sous is",
  "  and how it works.",
  "",
];

let tmp: TmpDir;
let fixtureRoot: string;
let manifestPath: string;

beforeEach(() => {
  tmp = makeTmpDir("sous-sync-core-version-");
  fixtureRoot = tmp.path;
  manifestPath = path.join(fixtureRoot, CORE_DIR, "sous.recipe.yaml");
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, MANIFEST.join("\n"), "utf8");
});

afterEach(() => {
  tmp.cleanup();
});

type RunResult = { stdout: string; stderr: string; status: number | null };

/** A lockfile the way sous writes one, pinning core and one other recipe. */
function lockfileText(coreVersion: string, coreHash: string): string {
  return (
    JSON.stringify(
      {
        formatVersion: 1,
        recipes: {
          "core/sous-skills": {
            hash: coreHash,
            kind: "subscribes",
            repo: "sous-recipes",
            requestedBy: ["project"],
            version: coreVersion,
          },
          "workflow/task-files": {
            hash: "sha256-cbdb330aafe322839017c404beaaefae3140553436962b1949065512e7c156c5",
            kind: "subscribes",
            repo: "sous-recipes",
            requestedBy: ["project"],
            version: "1.0.2",
          },
        },
        repos: {
          "sous-recipes": {
            identity: "github.com/sous-io/sous-recipes",
            url: "https://github.com/sous-io/sous-recipes",
          },
        },
      },
      null,
      2
    ) + "\n"
  );
}

/** Writes the fixture's lockfile, and returns its path. */
function writeLockfile(coreVersion: string, coreHash: string): string {
  const lockfilePath = path.join(fixtureRoot, ".sous", "sous.lock.json");
  fs.mkdirSync(path.dirname(lockfilePath), { recursive: true });
  fs.writeFileSync(lockfilePath, lockfileText(coreVersion, coreHash), "utf8");
  return lockfilePath;
}

/** Reads the fixture's lockfile back. */
function readLockfile(lockfilePath: string): {
  recipes: Record<string, { version: string; hash: string; requestedBy: string[] }>;
} {
  return JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
}

/** Writes the fixture's package.json with the given version. */
function writePackageJson(version: string): void {
  fs.writeFileSync(
    path.join(fixtureRoot, "package.json"),
    JSON.stringify({ name: "@sous-io/sous", version }, null, 2) + "\n",
    "utf8"
  );
}

/** Runs the script the way the release workflow does, against the fixture repository. */
function sync(): RunResult {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", scriptPath, fixtureRoot],
    { cwd: repoRoot, encoding: "utf8" }
  );
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe("sync-core-version", () => {
  /**
   * The ordinary case: the release commit has just raised package.json, and the
   * recipe follows it without the rest of the file moving.
   */
  it(
    "should write the package version into the core recipe, comments and all",
    () => {
      writePackageJson("0.2.0");

      const result = sync();
      const after = fs.readFileSync(manifestPath, "utf8");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("version 0.2.0");
      expect(after).toContain("version: 0.2.0");
      expect(after).toContain("# core/sous-skills");
      expect(after).toContain("# The offline seed that ships inside the package.");
      expect(after).toContain("description: >-");
      expect(after).not.toContain("0.1.1");
    },
    SCRIPT_TIMEOUT
  );

  /**
   * Running it on a repository that is already in step must not touch the file.
   * A YAML round trip can reflow a hand-written manifest, and a release commit
   * full of reformatting is a release commit nobody can read.
   */
  it(
    "should leave a recipe that already matches exactly as it was",
    () => {
      writePackageJson("0.1.1");
      const before = fs.readFileSync(manifestPath, "utf8");

      const result = sync();

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("already declares version 0.1.1");
      expect(fs.readFileSync(manifestPath, "utf8")).toBe(before);
    },
    SCRIPT_TIMEOUT
  );

  /**
   * A missing recipe is a broken package rather than a mistake the caller made,
   * and the message says so instead of failing with a stack trace.
   */
  it(
    "should fail readably when the packaged core recipe is missing",
    () => {
      writePackageJson("0.2.0");
      fs.rmSync(path.join(fixtureRoot, CORE_DIR), { recursive: true, force: true });

      const result = sync();

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("no core recipe manifest");
      expect(result.stderr).not.toContain("at Object.");
    },
    SCRIPT_TIMEOUT
  );

  /**
   * The repository's own lockfile follows the package version too: its core
   * entry moves to the new version with the hash of the packaged recipe as it
   * stands after the bump, and every other entry is carried through untouched.
   */
  it(
    "should move the lockfile's core entry to the package version, with the packaged hash",
    async () => {
      writePackageJson("0.2.0");
      const lockfilePath = writeLockfile("0.1.1", "sha256-" + "0".repeat(64));

      const result = sync();
      const after = readLockfile(lockfilePath);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Pinned core in .sous/sous.lock.json at version 0.2.0, from 0.1.1");
      expect(after.recipes["core/sous-skills"]!.version).toBe("0.2.0");
      expect(after.recipes["core/sous-skills"]!.hash).toBe(
        await hashDirectory(path.join(fixtureRoot, CORE_DIR))
      );
      expect(after.recipes["core/sous-skills"]!.requestedBy).toEqual(["project"]);
      expect(after.recipes["workflow/task-files"]!.version).toBe("1.0.2");
    },
    SCRIPT_TIMEOUT
  );

  /**
   * A lockfile already pinning the package version with the packaged hash is
   * not rewritten, so a release commit never carries a lockfile diff for
   * nothing. The hash is computed against the manifest as it will be AFTER the
   * sync, so the fixture is synced once to learn it.
   */
  it(
    "should leave a lockfile that already pins the package version and hash exactly as it was",
    async () => {
      writePackageJson("0.1.1");
      const lockfilePath = writeLockfile("0.1.1", await hashDirectory(path.join(fixtureRoot, CORE_DIR)));
      const before = fs.readFileSync(lockfilePath, "utf8");

      const result = sync();

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("already pins core at version 0.1.1");
      expect(fs.readFileSync(lockfilePath, "utf8")).toBe(before);
    },
    SCRIPT_TIMEOUT
  );

  /**
   * A repository with no lockfile, or a lockfile that pins no core entry, has
   * nothing for the lockfile step to do, and the script says nothing about it.
   */
  it(
    "should say nothing about the lockfile when there is none to move",
    () => {
      writePackageJson("0.2.0");

      const result = sync();

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("lockfile");
      expect(fs.existsSync(path.join(fixtureRoot, ".sous", "sous.lock.json"))).toBe(false);
    },
    SCRIPT_TIMEOUT
  );

  /** Without a package.json there is no version to copy, and the script says which file. */
  it(
    "should fail readably when there is no package.json to read",
    () => {
      const result = sync();

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("no package.json");
    },
    SCRIPT_TIMEOUT
  );
});
