/**
 * A repository added by its SSH address keeps building (gh-229, defect 1).
 *
 * `sous repo add git@gitlab.com:acme/recipes.git` used to succeed and then
 * leave a lockfile its own schema rejected, so every later subscribe and build
 * failed with "repos.<name>.url: Invalid input".
 *
 * Nothing here reaches the network: `fetch` is replaced by one that always
 * fails, and git's own `insteadOf` rewrite (in a throwaway global git config)
 * sends both of the repository's clone addresses to a local fixture
 * repository. That is the same path a real SSH clone takes, with only the
 * transport swapped.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { buildFixtureRepo, writeFixtureFile } from "../utils/fixture-repo.js";
import { binPath } from "../utils/sous-bin.js";

/** Per-test budget: every one of these boots the real CLI. */
const CLI_TIMEOUT = 120_000;

type RunResult = { stdout: string; stderr: string; status: number | null; output: string };

let tmp: TmpDir;
let sousHome: string;
let repo: string;
let projectRoot: string;
let gitConfig: string;
let offlineHook: string;

/** Runs `sous <args...>` through the real bin, offline, with git rewriting the hosted addresses. */
function sous(cwd: string, ...args: string[]): RunResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SOUS_HOME: sousHome,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file",
    NODE_OPTIONS: `--import=${pathToFileURL(offlineHook).href}`,
  };
  delete env.SOUS_CONFIG;
  delete env.SOUS_DIR;
  delete env.SOUS_CONFD;
  delete env.GITLAB_TOKEN;
  delete env.GL_TOKEN;
  const result = spawnSync(process.execPath, [binPath, ...args], { cwd, encoding: "utf8", env });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** The same, failing the test with everything printed unless it succeeded. */
function sousOk(cwd: string, ...args: string[]): RunResult {
  const result = sous(cwd, ...args);
  expect(result.status, result.output).toBe(0);
  return result;
}

beforeAll(async () => {
  tmp = makeTmpDir("sous-ssh-repo-url-");
  sousHome = path.join(tmp.path, "sous-home");
  repo = path.join(tmp.path, "fixtures");
  projectRoot = path.join(tmp.path, "project");

  await buildFixtureRepo(repo, "recipes", [
    {
      namespace: "team",
      name: "notes",
      version: "1.0.0",
      files: { "skills/notes/SKILL.md": "# Notes from the SSH repository\n" },
    },
  ]);

  const local = pathToFileURL(repo).href;
  gitConfig = writeFixtureFile(
    path.join(tmp.path, "gitconfig"),
    [
      `[url "${local}"]`,
      "\tinsteadOf = git@gitlab.com:acme/recipes.git",
      "\tinsteadOf = https://gitlab.com/acme/recipes.git",
      "",
    ].join("\n")
  );

  offlineHook = writeFixtureFile(
    path.join(tmp.path, "offline.mjs"),
    ["globalThis.fetch = async (url) => {", "  throw new Error(`offline: this test machine cannot reach ${url}`);", "};", ""].join("\n")
  );

  writeFixtureFile(
    path.join(projectRoot, ".sous", "sous.config.js"),
    [
      "export const config = {",
      '  name: "SSH Repository Project",',
      '  repos: { "sous-recipes": { enabled: false } },',
      "};",
      "",
    ].join("\n")
  );
}, CLI_TIMEOUT);

afterAll(() => {
  tmp.cleanup();
});

describe("a repository added by its SSH address", () => {
  /**
   * The scp-like address is added, a recipe from it is subscribed and built,
   * and the lockfile records the address as it was given.
   *
   * sous repo add git@gitlab.com:acme/recipes.git --name recipes --trust
   * sous subscription add team/notes --yes
   * // -> .sous/sous.lock.json: repos.recipes.url = "git@gitlab.com:acme/recipes.git"
   */
  it(
    "should subscribe and build from it",
    () => {
      sousOk(projectRoot, "repo", "add", "git@gitlab.com:acme/recipes.git", "--name", "recipes", "--trust");
      sousOk(projectRoot, "subscription", "add", "team/notes", "--yes");

      const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, ".sous", "sous.lock.json"), "utf8")) as {
        repos: Record<string, { url: string; identity?: string }>;
        recipes: Record<string, { repo: string; version: string }>;
      };

      expect(lock.repos["recipes"]).toMatchObject({ url: "git@gitlab.com:acme/recipes.git", identity: "gitlab.com/acme/recipes" });
      expect(lock.recipes["team/notes"]).toMatchObject({ repo: "recipes", version: "1.0.0" });
    },
    CLI_TIMEOUT
  );

  /**
   * A later build reads the lockfile it wrote, rather than rejecting it, and
   * the recipe was fetched through git into the store under its host identity.
   *
   * sous build
   * // -> exit 0; <SOUS_HOME>/cache/gitlab.com/acme/recipes/team/notes/1.0.0 exists
   */
  it(
    "should keep building once the lockfile records the SSH address",
    () => {
      sousOk(projectRoot, "build");

      const entry = path.join(sousHome, "cache", "gitlab.com", "acme", "recipes", "team", "notes", "1.0.0");
      expect(fs.existsSync(path.join(entry, "skills", "notes", "SKILL.md"))).toBe(true);
    },
    CLI_TIMEOUT
  );
});
