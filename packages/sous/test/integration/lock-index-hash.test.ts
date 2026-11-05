/**
 * The lockfile regains a repository's `indexHash` (gh-204, bug 36).
 *
 * The lockfile records, for each repository, the hash of the cached index it
 * was resolved against. When it was written while the cache had no hash, it
 * lacked `indexHash`, and no later build added it back until a pin changed, so
 * this machine's lockfile differed from everyone else's.
 *
 * Everything runs against a local fixture repository read through the `local`
 * provider, so nothing here touches the network.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { buildFixtureRepo, writeFixtureFile } from "../utils/fixture-repo.js";
import { binPath } from "../utils/sous-bin.js";

/** Per-test budget: every one of these boots the real CLI several times. */
const CLI_TIMEOUT = 120_000;

type RunResult = { stdout: string; stderr: string; status: number | null; output: string };
type Lock = { repos: Record<string, { url: string; identity?: string; indexHash?: string }> };

let tmp: TmpDir;
let sousHome: string;
let repo: string;
let projectRoot: string;

/** Runs `sous <args...>` through the real bin, from `cwd`, with the store in this test's directory. */
function sous(cwd: string, ...args: string[]): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env, SOUS_HOME: sousHome };
  delete env.SOUS_CONFIG;
  delete env.SOUS_DIR;
  delete env.SOUS_CONFD;
  const result = spawnSync(process.execPath, [binPath, ...args], { cwd, encoding: "utf8", env });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** The same, failing the test with everything printed unless it succeeded. */
function sousOk(cwd: string, ...args: string[]): RunResult {
  const result = sous(cwd, ...args);
  expect(result.status, result.output).toBe(0);
  return result;
}

function lockPath(): string {
  return path.join(projectRoot, ".sous", "sous.lock.json");
}

function readLock(): Lock {
  return JSON.parse(fs.readFileSync(lockPath(), "utf8")) as Lock;
}

/** Every cached index sidecar under the test's store. */
function sidecars(): string[] {
  const root = path.join(sousHome, "cache", "_indexes");
  return fs
    .readdirSync(root, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".meta.json"))
    .map((file) => path.join(root, file));
}

beforeAll(async () => {
  tmp = makeTmpDir("sous-lock-index-hash-");
  sousHome = path.join(tmp.path, "sous-home");
  repo = path.join(tmp.path, "fixtures");
  projectRoot = path.join(tmp.path, "project");

  await buildFixtureRepo(repo, "fixtures", [
    {
      namespace: "team",
      name: "notes",
      version: "1.0.0",
      files: { "skills/notes/SKILL.md": "# Notes\n" },
    },
  ]);

  writeFixtureFile(
    path.join(projectRoot, ".sous", "sous.config.js"),
    ["export const config = {", '  name: "Index Hash Project",', '  repos: { "sous-recipes": { enabled: false } },', "};", ""].join("\n")
  );
  sousOk(projectRoot, "repo", "add", repo, "--name", "fixtures", "--trust");
  sousOk(projectRoot, "subscription", "add", "team/notes", "--yes");
}, CLI_TIMEOUT);

afterAll(() => {
  tmp.cleanup();
});

describe("a lockfile missing a repository's index hash", () => {
  /**
   * The cache entry had no hash when the lockfile was written; once it has
   * one, the next build records it, though no pin changed.
   *
   * (lockfile written without repos.fixtures.indexHash; cache sidecar has a hash)
   * sous build
   * // -> repos.fixtures.indexHash = the sidecar's hash
   */
  it(
    "should record the cached index's hash on the next build",
    () => {
      const metas = sidecars().map((file) => JSON.parse(fs.readFileSync(file, "utf8")) as { hash?: string });
      const hash = metas.find((meta) => meta.hash !== undefined)?.hash;
      expect(hash, "the cached index should have a hash").toBeDefined();

      const lock = readLock();
      delete lock.repos["fixtures"]!.indexHash;
      fs.writeFileSync(lockPath(), `${JSON.stringify(lock, null, 2)}\n`, "utf8");

      sousOk(projectRoot, "build");

      expect(readLock().repos["fixtures"]!.indexHash).toBe(hash);
    },
    CLI_TIMEOUT
  );

  /**
   * A dry run still writes nothing.
   *
   * (lockfile without indexHash) sous build --dry-run
   * // -> lockfile unchanged
   */
  it(
    "should leave the lockfile alone on a dry run",
    () => {
      const lock = readLock();
      delete lock.repos["fixtures"]!.indexHash;
      const text = `${JSON.stringify(lock, null, 2)}\n`;
      fs.writeFileSync(lockPath(), text, "utf8");

      sousOk(projectRoot, "build", "--dry-run");

      expect(fs.readFileSync(lockPath(), "utf8")).toBe(text);
    },
    CLI_TIMEOUT
  );
});
