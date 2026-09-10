import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { commitAll, git, initRepo } from "../utils/git-repo.js";
import { parseIndexFile } from "../../lib/repos/formats/index-file.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");

/** Per-test timeout: each test boots the real CLI (tsx + oclif) in a subprocess. */
const CLI_TIMEOUT = 60_000;

type RunResult = { stdout: string; stderr: string; status: number | null };

let tmp: TmpDir;
let recipeRepo: string;
let fakeBin: string;

/**
 * Runs `sous <args...>` through the real published bin, from the recipe
 * repository. Ambient SOUS_* variables are stripped so nothing in the runner's
 * own environment can decide what the child does, and the directory holding the
 * fake provider CLI is put at the front of PATH.
 */
function runSous(...args: string[]): RunResult {
  const childEnv = { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH}` };
  delete childEnv.SOUS_CONFIG;
  delete childEnv.SOUS_DIR;
  delete childEnv.SOUS_CONFD;
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd: recipeRepo,
    encoding: "utf8",
    env: childEnv,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/** Reads the repository's index back, validated. */
function readIndex() {
  const text = fs.readFileSync(path.join(recipeRepo, "sous.index.json"), "utf8");
  return parseIndexFile(JSON.parse(text), "sous.index.json");
}

/**
 * These tests drive `sous repo release` and `sous repo submit` end to end
 * through the real CLI, against a repository created by `sous repo init` in a
 * temporary directory. Git is real; the provider's CLI is a shell script on
 * PATH, so the submission preflight runs in full without a network.
 */
describe("sous repo release and sous repo submit", () => {
  beforeAll(() => {
    tmp = makeTmpDir("sous-release-e2e-");
    recipeRepo = path.join(tmp.path, "recipes");
    fakeBin = path.join(tmp.path, "bin");

    // A stand-in for the GitHub CLI: signed in, with push permission, and a
    // login to fork under. Nothing here can reach the network.
    fs.mkdirSync(fakeBin, { recursive: true });
    const gh = path.join(fakeBin, "gh");
    fs.writeFileSync(
      gh,
      [
        "#!/bin/sh",
        'if [ "$1" = "auth" ]; then exit 0; fi',
        'if [ "$1" = "api" ] && [ "$2" = "user" ]; then echo contributor; exit 0; fi',
        'if [ "$1" = "api" ]; then echo true; exit 0; fi',
        'echo "https://github.com/owner/recipes/pull/1"',
        "exit 0",
        "",
      ].join("\n"),
      "utf8"
    );
    fs.chmodSync(gh, 0o755);

    const init = spawnSync(
      process.execPath,
      [binPath, "repo", "init", recipeRepo, "--name", "test-repo", "--namespace", "core"],
      { cwd: tmp.path, encoding: "utf8" }
    );
    if (init.status !== 0) {
      throw new Error(`sous repo init failed: ${init.stderr || init.stdout}`);
    }

    initRepo(recipeRepo);
    git(recipeRepo, "remote", "add", "origin", "https://github.com/owner/recipes.git");
    commitAll(recipeRepo, "scaffold the repository");
  });

  afterAll(() => {
    tmp.cleanup();
  });

  /**
   * A freshly scaffolded repository validates, and its one recipe version is
   * pending: nothing has been tagged, so nothing is published yet.
   */
  it(
    "should propose the scaffolded recipe as a pending version",
    () => {
      const result = runSous("repo", "release");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Versions with no tag yet");
      expect(result.stdout).toContain("core/example");
      expect(result.stdout).toContain("core/example@0.1.0");
      expect(readIndex().recipes).toEqual({});
    },
    CLI_TIMEOUT
  );

  /**
   * `--check` is what a pull request runs: it reads, reports and succeeds while
   * the committed index is current.
   */
  it(
    "should pass --check while the committed index is current",
    () => {
      const result = runSous("repo", "release", "--check");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("is current");
    },
    CLI_TIMEOUT
  );

  /**
   * `--tag` publishes: it cuts the annotated tag for every pending version and
   * rewrites the index to record it, leaving the commit to the author.
   */
  it(
    "should tag the pending version and record it in the index",
    () => {
      const result = runSous("repo", "release", "--tag");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Created the tag core/example@0.1.0");
      expect(git(recipeRepo, "tag", "--list")).toContain("core/example@0.1.0");

      const versions = readIndex().recipes["core/example"]!.versions;
      expect(Object.keys(versions)).toEqual(["0.1.0"]);
      expect(versions["0.1.0"]!.tag).toBe("core/example@0.1.0");
      expect(versions["0.1.0"]!.hash).toMatch(/^sha256-[0-9a-f]{64}$/);
    },
    CLI_TIMEOUT
  );

  /**
   * `--tag` refuses to run again while the rewritten index is uncommitted: a
   * tag names one commit, and sous does not make that commit for the author.
   */
  it(
    "should refuse to tag while the working tree has uncommitted changes",
    () => {
      const result = runSous("repo", "release", "--tag");

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("uncommitted changes");
      expect(result.stdout).toContain("sous.index.json");
    },
    CLI_TIMEOUT
  );

  /**
   * An index that has fallen behind the tags fails `--check`, and the message
   * names the version that is missing rather than saying two files differ.
   */
  it(
    "should fail --check when the committed index has fallen behind the tags",
    () => {
      commitAll(recipeRepo, "record the published version");
      expect(runSous("repo", "release", "--check").status).toBe(0);

      git(recipeRepo, "revert", "--no-edit", "HEAD");
      const result = runSous("repo", "release", "--check");
      // Put the index back before asserting, so one failed expectation cannot
      // leave the repository broken for every test after it.
      git(recipeRepo, "revert", "--no-edit", "HEAD");

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("out of date");
      expect(result.stdout).toContain("the recipe 'core/example' is missing from the index");
    },
    CLI_TIMEOUT
  );

  /**
   * `--bump` raises the version in place, and the next run proposes the new
   * version as pending.
   */
  it(
    "should raise the version with --bump and propose the new one",
    () => {
      const result = runSous("repo", "release", "--bump", "minor");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("core/example: 0.1.0 becomes 0.2.0");
      expect(result.stdout).toContain("core/example@0.2.0");

      const manifest = fs.readFileSync(
        path.join(recipeRepo, "recipes/core/example/sous.recipe.yaml"),
        "utf8"
      );
      expect(manifest).toContain("version: 0.2.0");
      expect(manifest).toContain("# A recipe manifest: one publishable unit");

      git(recipeRepo, "checkout", "--", ".");
    },
    CLI_TIMEOUT
  );

  /**
   * `sous repo submit --dry-run` runs the whole preflight (validation, the
   * index check, the provider, its CLI, and the working tree) and sends
   * nothing.
   */
  it(
    "should run the submission preflight and send nothing on a dry run",
    () => {
      const result = runSous("repo", "submit", "--dry-run");

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Checking that the GitHub CLI is installed");
      expect(result.stdout).toContain("Nothing was sent");
      expect(result.stdout).toContain("owner/recipes");
      expect(git(recipeRepo, "branch", "--list")).not.toContain("sous/submit-");
    },
    CLI_TIMEOUT
  );

  /**
   * A submission is refused while anything is uncommitted, and the message
   * lists exactly what the contributor still has to commit.
   */
  it(
    "should refuse to submit while anything is uncommitted",
    () => {
      const scratch = path.join(recipeRepo, "recipes/core/example/skills/extra.md");
      fs.writeFileSync(scratch, "extra\n", "utf8");

      const result = runSous("repo", "submit");

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("uncommitted changes");
      expect(result.stdout).toContain("extra.md");

      fs.rmSync(scratch);
    },
    CLI_TIMEOUT
  );
});
