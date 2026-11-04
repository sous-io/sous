/**
 * A fresh clone of a project on a machine that cannot download its recipes (no credentials, no
 * network), end to end through the real CLI (#204, bug 3).
 *
 * The project is set up and built on one "machine" (a `SOUS_HOME` that holds the recipes). A
 * second, empty `SOUS_HOME` then stands for a teammate's first run, and the fixture repository is
 * moved away so nothing can be downloaded. Commands that read no recipe files must still work;
 * a command that needs them must fail and say why.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { buildFixtureRepo, writeFixtureFile } from "../utils/fixture-repo.js";
import { binPath } from "../utils/sous-bin.js";

/** Per-test budget: every one of these boots the real CLI. */
const CLI_TIMEOUT = 120_000;

type RunResult = { stdout: string; stderr: string; status: number | null; output: string };

let tmp: TmpDir;
let repo: string;
let projectRoot: string;
let freshHome: string;

/** Runs `sous <args...>` through the real bin, from the project, with the given `SOUS_HOME`. */
function sous(home: string, ...args: string[]): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env, SOUS_HOME: home };
  delete env.SOUS_CONFIG;
  delete env.SOUS_DIR;
  delete env.SOUS_CONFD;
  const result = spawnSync(process.execPath, [binPath, ...args], { cwd: projectRoot, encoding: "utf8", env });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status, output: `${result.stdout}${result.stderr}` };
}

beforeAll(async () => {
  tmp = makeTmpDir("sous-fresh-clone-");
  const firstHome = path.join(tmp.path, "first-home");
  freshHome = path.join(tmp.path, "fresh-home");
  repo = path.join(tmp.path, "fixtures");
  projectRoot = path.join(tmp.path, "project");

  await buildFixtureRepo(repo, "fixtures", [
    { namespace: "lib", name: "one", version: "1.0.0", files: { "skills/one/SKILL.md": "# one\n" } },
  ]);
  writeFixtureFile(
    path.join(projectRoot, ".sous", "sous.config.js"),
    ["export const config = {", '  name: "Fresh Clone Project",', '  repos: { "sous-recipes": { enabled: false } },', "};", ""].join("\n")
  );

  for (const args of [["repo", "add", repo, "--name", "fixtures", "--trust"], ["subscription", "add", "lib/one", "--yes"]]) {
    const result = sous(firstHome, ...args);
    expect(result.status, result.output).toBe(0);
  }

  // The teammate's machine: an empty store, and a repository it cannot reach.
  fs.renameSync(repo, `${repo}-gone`);
}, CLI_TIMEOUT);

afterAll(() => {
  tmp.cleanup();
});

describe("a fresh clone whose recipes cannot be downloaded", () => {
  /**
   * Help and the version download nothing, so they work.
   *
   * sous --help; sous --version
   * // -> exit 0, no download error
   */
  it(
    "should still show help and the version",
    () => {
      for (const args of [["--help"], ["--version"], ["subscription", "--help"]]) {
        const result = sous(freshHome, ...args);

        expect(result.status, result.output).toBe(0);
        expect(result.output).not.toMatch(/could not download/);
      }
    },
    CLI_TIMEOUT
  );

  /**
   * Commands that read only the project's own config and lockfile work too, with nothing said
   * about the recipes they left out.
   *
   * sous repo list; sous subscription list
   * // -> exit 0; lib/one is listed
   */
  it(
    "should run commands that read no recipe files",
    () => {
      const repos = sous(freshHome, "repo", "list");
      expect(repos.status, repos.output).toBe(0);
      expect(repos.output).not.toMatch(/could not download/);

      const subscriptions = sous(freshHome, "subscription", "list");
      expect(subscriptions.status, subscriptions.output).toBe(0);
      expect(subscriptions.stdout).toContain("lib/one");
    },
    CLI_TIMEOUT
  );

  /**
   * A command that needs the recipe files fails, and says which recipe and why.
   *
   * sous build
   * // -> exit 1: "Sous could not download a recipe this project's subscriptions need." … lib/one …
   */
  it(
    "should fail a build, naming the recipe it could not download",
    () => {
      const result = sous(freshHome, "build");

      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toMatch(/could not download a recipe/);
      expect(result.output).toContain("lib/one");
    },
    CLI_TIMEOUT
  );
});
