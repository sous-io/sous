import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { commitAll, git, initRepo, writeFile } from "../utils/git-repo.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");

/** Per-test timeout: each test boots the real CLI (tsx + oclif) in a subprocess. */
const CLI_TIMEOUT = 60_000;

type RunResult = { stdout: string; stderr: string; status: number | null };

let tmp: TmpDir;
let recipeRepo: string;
let bareRemote: string;
let fakeBin: string;
let ghState: string;

/**
 * Runs `sous <args...>` through the real published bin. Ambient SOUS_*
 * variables are stripped, the fake GitHub CLI is put at the front of PATH, and
 * the machine-wide sous home is redirected into the temp tree.
 *
 * @param cwd - Where to run it.
 * @param args - The command line.
 */
function runSousIn(cwd: string, ...args: string[]): RunResult {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    SOUS_HOME: path.join(tmp.path, "sous-home"),
    FAKE_GH_STATE: ghState,
    GIT_AUTHOR_NAME: "Sous Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Sous Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  delete childEnv.SOUS_CONFIG;
  delete childEnv.SOUS_DIR;
  delete childEnv.SOUS_CONFD;
  delete childEnv.CI;
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/** Runs sous from inside the recipe repository. */
function runSous(...args: string[]): RunResult {
  return runSousIn(recipeRepo, ...args);
}

/** Sets what the fake `gh pr list` and `gh pr view` answer with. */
function setProposal(proposal: Record<string, unknown> | undefined): void {
  const listed = proposal === undefined ? [] : [{ isCrossRepository: false, ...proposal }];
  fs.writeFileSync(path.join(ghState, "list.json"), JSON.stringify(listed), "utf8");
  fs.writeFileSync(
    path.join(ghState, "view.json"),
    JSON.stringify({
      reviewDecision: "REVIEW_REQUIRED",
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      mergeable: "MERGEABLE",
      ...(proposal ?? {}),
    }),
    "utf8"
  );
}

/** Every `gh` call the fake recorded, one line each, and clears the record. */
function takeGhCalls(): string {
  const log = path.join(ghState, "calls.log");
  const text = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  fs.rmSync(log, { force: true });
  return text;
}

/** Branches the bare remote holds. */
function remoteBranches(): string {
  return git(bareRemote, "branch", "--list");
}

/** An open pull request for a branch, as the fake reports it. */
function openProposal(branch: string, state = "OPEN"): Record<string, unknown> {
  return {
    number: 7,
    url: "https://github.com/owner/recipes/pull/7",
    state,
    title: "Add a skill",
    isDraft: false,
    baseRefName: "main",
    headRefName: branch,
  };
}

/**
 * These tests drive `sous repo submit` end to end through the real CLI. Git is
 * real, and pushes go to a bare repository in the temp tree (the origin's push
 * URL points there, while its fetch URL still names GitHub so the GitHub
 * provider handles it); the GitHub CLI is a shell script on PATH whose answers
 * come from files the tests write. Nothing reaches a network.
 */
describe("sous repo submit, over a proposal's life", () => {
  beforeAll(() => {
    tmp = makeTmpDir("sous-submit-e2e-");
    recipeRepo = path.join(tmp.path, "recipes");
    bareRemote = path.join(tmp.path, "remote.git");
    fakeBin = path.join(tmp.path, "bin");
    ghState = path.join(tmp.path, "gh-state");
    fs.mkdirSync(ghState, { recursive: true });

    fs.mkdirSync(fakeBin, { recursive: true });
    const gh = path.join(fakeBin, "gh");
    fs.writeFileSync(
      gh,
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$FAKE_GH_STATE/calls.log"',
        'if [ "$1" = "auth" ]; then exit 0; fi',
        'if [ "$1" = "api" ] && [ "$2" = "user" ]; then echo contributor; exit 0; fi',
        'if [ "$1" = "api" ]; then echo true; exit 0; fi',
        'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then cat "$FAKE_GH_STATE/list.json"; exit 0; fi',
        'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then cat "$FAKE_GH_STATE/view.json"; exit 0; fi',
        'echo "https://github.com/owner/recipes/pull/7"',
        "exit 0",
        "",
      ].join("\n"),
      "utf8"
    );
    fs.chmodSync(gh, 0o755);
    setProposal(undefined);

    const init = spawnSync(
      process.execPath,
      [binPath, "repo", "init", recipeRepo, "--name", "test-repo", "--namespace", "core"],
      { cwd: tmp.path, encoding: "utf8" }
    );
    if (init.status !== 0) {
      throw new Error(`sous repo init failed: ${init.stderr || init.stdout}`);
    }

    initRepo(recipeRepo);
    commitAll(recipeRepo, "scaffold the repository");

    fs.mkdirSync(bareRemote);
    git(bareRemote, "init", "--quiet", "--bare", "--initial-branch", "main");
    git(recipeRepo, "remote", "add", "origin", "https://github.com/owner/recipes.git");
    git(recipeRepo, "remote", "set-url", "--push", "origin", bareRemote);
    git(recipeRepo, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(recipeRepo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  });

  afterAll(() => {
    tmp.cleanup();
  });

  /**
   * A new proposal needs a title and a description written by a person. With
   * no terminal to ask on, the failure names both flags and nothing is written.
   */
  it(
    "should fail naming --title and --body when it cannot ask for them",
    () => {
      writeFile(recipeRepo, "recipes/core/example/skills/contributed.md", "contributed\n");
      commitAll(recipeRepo, "contribute a skill");

      const result = runSous("repo", "submit", "--branch", "add-a-skill");
      const output = result.stdout + result.stderr;

      expect(result.status).toBe(1);
      expect(output).toContain("'--title' and '--body'");
      expect(git(recipeRepo, "branch", "--list", "add-a-skill")).toBe("");
      expect(remoteBranches()).toBe("");
    },
    CLI_TIMEOUT
  );

  /**
   * The first run opens a proposal: the branch is created, pushed, and a pull
   * request is opened whose body is the description followed by the changelog.
   */
  it(
    "should open a proposal with the description and the changelog",
    () => {
      takeGhCalls();
      const result = runSous(
        "repo",
        "submit",
        "--branch",
        "add-a-skill",
        "--title",
        "Add a skill",
        "--body",
        "It adds a contributed skill."
      );

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("The pull request that was opened");
      expect(result.stdout).toContain("What merging this changes");
      expect(remoteBranches()).toContain("add-a-skill");
      const calls = takeGhCalls();
      expect(calls).toContain("pr create");
      expect(calls).toContain("It adds a contributed skill.");
      expect(calls).toContain("## What merging this changes");
    },
    CLI_TIMEOUT
  );

  /**
   * Run again with nothing new, the open proposal is found, left as it is,
   * and reported on; a second one is never opened.
   */
  it(
    "should find the open proposal and leave it alone when nothing is new",
    () => {
      setProposal(openProposal("add-a-skill"));

      const result = runSous("repo", "submit");

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("nothing new to send");
      expect(result.stdout).toContain("review required");
      expect(takeGhCalls()).not.toContain("pr create");
    },
    CLI_TIMEOUT
  );

  /**
   * New commits on the branch are pushed, which updates the open proposal,
   * and a new title replaces its own.
   */
  it(
    "should push new commits to the open proposal and replace its title",
    () => {
      writeFile(recipeRepo, "recipes/core/example/skills/contributed.md", "revised\n");
      commitAll(recipeRepo, "revise after review");

      const result = runSous("repo", "submit", "--title", "Add a better skill");

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("was updated");
      const calls = takeGhCalls();
      expect(calls).toContain("pr edit 7");
      expect(calls).toContain("Add a better skill");
      expect(calls).not.toContain("pr create");
      expect(git(bareRemote, "log", "-1", "--format=%s", "add-a-skill")).toBe(
        "revise after review"
      );
    },
    CLI_TIMEOUT
  );

  /**
   * `--status` only reports, for the current branch or the one `--branch`
   * names.
   */
  it(
    "should report where the proposal stands with --status",
    () => {
      const before = git(bareRemote, "rev-parse", "add-a-skill");

      const result = runSous("repo", "submit", "--status", "--branch", "add-a-skill");

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("State");
      expect(result.stdout).toContain("open");
      expect(result.stdout).toContain("1 passed, 0 failed");
      expect(git(bareRemote, "rev-parse", "add-a-skill")).toBe(before);
    },
    CLI_TIMEOUT
  );

  /**
   * Once the proposal is merged, `--yes` continues on a generated branch, and
   * that branch gets a new proposal. Without a terminal and without `--yes`,
   * the question fails naming the flag.
   */
  it(
    "should continue on a new branch after the proposal was merged",
    () => {
      setProposal(openProposal("add-a-skill", "MERGED"));
      writeFile(recipeRepo, "recipes/core/example/skills/follow-up.md", "follow up\n");
      commitAll(recipeRepo, "follow up");

      const refused = runSous("repo", "submit", "--title", "Follow up", "--body", "More.");
      expect(refused.status).toBe(1);
      expect(refused.stdout + refused.stderr).toContain("--yes");

      takeGhCalls();
      const result = runSous("repo", "submit", "--yes", "--title", "Follow up", "--body", "More.");

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("was merged");
      expect(git(recipeRepo, "rev-parse", "--abbrev-ref", "HEAD")).toMatch(/^sous\/submit-/);
      expect(takeGhCalls()).toContain("pr create");
    },
    CLI_TIMEOUT
  );

  /**
   * A proposal closed without merging is reported, and a fresh one is opened
   * for the same branch.
   */
  it(
    "should open a fresh proposal after the last one was closed",
    () => {
      const branch = git(recipeRepo, "rev-parse", "--abbrev-ref", "HEAD");
      setProposal(openProposal(branch, "CLOSED"));
      takeGhCalls();

      const result = runSous("repo", "submit", "--title", "Try again", "--body", "Again.");

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("closed without being merged");
      expect(takeGhCalls()).toContain("pr create");
      expect(git(recipeRepo, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
    },
    CLI_TIMEOUT
  );

  /**
   * `--commit` commits the contributor's change for them, with the title, the
   * description and the changelog as the message; `--yes` answers the
   * confirmation.
   */
  it(
    "should commit uncommitted changes with --commit",
    () => {
      setProposal(undefined);
      git(recipeRepo, "checkout", "--quiet", "main");
      writeFile(recipeRepo, "recipes/core/example/skills/committed.md", "committed\n");

      const result = runSous(
        "repo",
        "submit",
        "--commit",
        "--yes",
        "--branch",
        "committed-for-me",
        "--title",
        "Commit it for me",
        "--body",
        "Sous commits this."
      );

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(git(recipeRepo, "status", "--porcelain")).toBe("");
      const message = git(recipeRepo, "log", "-1", "--format=%B");
      expect(message).toMatch(/^Commit it for me\n\nSous commits this\.\n\n## What merging this changes/);
      expect(remoteBranches()).toContain("committed-for-me");
    },
    CLI_TIMEOUT
  );

  /**
   * Run from a project, the argument names a linked repository and the
   * submission runs in its checkout.
   */
  it(
    "should run from a project, in the linked repository's checkout",
    () => {
      const project = path.join(tmp.path, "project");
      writeFile(project, ".sous/sous.config.json", '{ "version": 1 }\n');
      writeFile(
        project,
        ".sous/sous.links.json",
        JSON.stringify({
          formatVersion: 1,
          links: {
            "test-repo": {
              path: recipeRepo,
              linkedAt: "2026-09-27T00:00:00.000Z",
              origin: "path",
            },
          },
        })
      );

      const result = runSousIn(project, "repo", "submit", "test-repo", "--status");

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain(recipeRepo);
      expect(result.stdout).toContain("'test-repo' is linked to this checkout");
      expect(result.stdout).toContain("has no pull request");
    },
    CLI_TIMEOUT
  );

  /**
   * `sous repo release --check` fails a pull request that changes a recipe
   * that takes no proposals, naming where changes go instead.
   */
  it(
    "should fail release --check for a change to a recipe that takes no proposals",
    () => {
      git(recipeRepo, "checkout", "--quiet", "main");
      const manifest = path.join(recipeRepo, "recipes/core/example/sous.recipe.yaml");
      fs.writeFileSync(
        manifest,
        `${fs.readFileSync(manifest, "utf8")}submissions:\n  allowed: false\n` +
          "  instead: Propose it upstream.\n",
        "utf8"
      );
      commitAll(recipeRepo, "decline proposals");
      git(recipeRepo, "update-ref", "refs/remotes/origin/main", "HEAD");

      const clean = runSous("repo", "release", "--check");
      expect(clean.stdout + clean.stderr).not.toContain("does not take proposed changes");

      git(recipeRepo, "checkout", "--quiet", "-b", "touch-declined");
      writeFile(recipeRepo, "recipes/core/example/skills/declined.md", "declined\n");
      commitAll(recipeRepo, "touch a recipe that declines proposals");

      const result = runSous("repo", "release", "--check");

      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain("does not take proposed changes");
      expect(result.stdout + result.stderr).toMatch(/Propose it\s+upstream\./);
    },
    CLI_TIMEOUT
  );
});
