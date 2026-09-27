import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");

/** Per-test timeout: each test boots the real CLI (tsx + oclif) in a subprocess. */
const CLI_TIMEOUT = 30_000;

type RunResult = { stdout: string; stderr: string; status: number | null; output: string };

/** Strips ANSI escape codes, so assertions read the words and not the colors. */
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * Runs `sous <args...>` through the real published bin, from `cwd`. Ambient
 * SOUS_* variables are stripped so a value in the runner's own environment can
 * never decide where the child writes; SOUS_HOME points into the temp tree.
 */
function runSous(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): RunResult {
  const childEnv = { ...process.env, ...env };
  delete childEnv.SOUS_CONFIG;
  delete childEnv.SOUS_DIR;
  delete childEnv.SOUS_CONFD;
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: "utf8",
    env: childEnv,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status,
    output: strip(`${result.stdout}${result.stderr}`),
  };
}

/** Runs a git command in `cwd` and returns its trimmed output, failing loudly on error. */
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.stdout}`
    );
  }
  return result.stdout.trim();
}

/** Commits one change to a file, as the test identity. */
function commitFile(cwd: string, file: string, content: string, message: string): void {
  fs.writeFileSync(path.join(cwd, file), content, "utf8");
  git(cwd, "add", file);
  git(cwd, "commit", "-qm", message);
}

/**
 * `sous repo link` on a checkout that already exists: the divergence report,
 * the branch flags and `--latest`, end to end through the real CLI.
 *
 * Upstream is a local bare repository, so nothing reaches the network. The
 * tests share one project and one clone and run in order, each leaving the
 * checkout in the state the next one expects.
 */
describe("sous repo link branch flags and upstream report", () => {
  let tmp: TmpDir;
  let root: string;
  let author: string;
  let bareRepo: string;
  let movedBare: string;
  let projectRoot: string;
  let checkout: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    tmp = makeTmpDir("sous-link-branches-");
    root = fs.realpathSync(tmp.path);
    author = path.join(root, "author");
    bareRepo = path.join(root, "origin.git");
    movedBare = path.join(root, "origin-moved.git");
    projectRoot = path.join(root, "project");
    const sousDir = path.join(projectRoot, ".sous");
    env = { SOUS_HOME: path.join(root, "sous-home") };

    fs.mkdirSync(sousDir, { recursive: true });

    const init = runSous(root, env, "repo", "init", author, "--name", "demo-recipes");
    if (init.status !== 0) throw new Error(`repo init failed: ${init.output}`);

    git(author, "init", "-q", "-b", "main");
    git(author, "config", "user.email", "tests@example.com");
    git(author, "config", "user.name", "Sous Tests");
    git(author, "add", "-A");
    git(author, "commit", "-qm", "the scaffold");
    git(author, "switch", "-q", "-c", "feature");
    commitFile(author, "feature.txt", "feature\n", "a feature");
    git(author, "switch", "-q", "main");
    git(root, "init", "-q", "--bare", "-b", "main", bareRepo);
    git(author, "remote", "add", "origin", bareRepo);
    git(author, "push", "-q", "origin", "main", "feature");

    fs.writeFileSync(
      path.join(sousDir, "sous.config.json"),
      JSON.stringify(
        { name: "link-branches", repos: { "demo-recipes": { url: `file://${bareRepo}` } } },
        null,
        2
      ),
      "utf8"
    );

  }, 120_000);

  afterAll(() => {
    tmp.cleanup();
  });

  /** Where a links map in `directory` says `demo-recipes` is checked out. */
  const linkedPath = (directory: string): string => {
    const map = JSON.parse(
      fs.readFileSync(path.join(directory, "sous.links.json"), "utf8")
    ) as { links: Record<string, { path: string }> };
    return map.links["demo-recipes"]!.path;
  };

  /** The branch the linked checkout has checked out. */
  const branchOf = () => git(checkout, "symbolic-ref", "--short", "HEAD");

  /**
   * The first link clones, so there is nothing to compare; the second reuses
   * the clone and, after a fetch, reports its branch, whether it is merged and
   * how far it is behind the upstream default branch.
   *
   * sous repo link demo-recipes   // -> Behind origin/main: 1 commit
   */
  it(
    "should report how a reused checkout compares with upstream",
    () => {
      const first = runSous(projectRoot, env, "repo", "link", "demo-recipes");
      expect(first.status, first.output).toBe(0);
      checkout = linkedPath(path.join(projectRoot, ".sous"));
      expect(fs.existsSync(path.join(checkout, "sous.repo.yaml"))).toBe(true);
      expect(first.output).not.toContain("Compared with");

      commitFile(author, "later.txt", "later\n", "upstream moves on");
      git(author, "push", "-q", "origin", "main");

      const second = runSous(projectRoot, env, "repo", "link", "demo-recipes");
      expect(second.status, second.output).toBe(0);
      expect(second.output).toMatch(/Branch\s*: main/);
      expect(second.output).not.toContain("Checked out");
      expect(second.output).toMatch(/Merged into origin\/main\s*: yes/);
      expect(second.output).toMatch(/Behind origin\/main\s*: 1 commit\b/);
      expect(second.output).toContain("nothing in the checkout was changed");
      // The report fetched; it did not pull.
      expect(fs.existsSync(path.join(checkout, "later.txt"))).toBe(false);
    },
    CLI_TIMEOUT
  );

  /**
   * `--branch` switches to a branch that exists only upstream, which a
   * single-branch clone cannot see until the branch is fetched.
   *
   * sous repo link demo-recipes --branch feature
   */
  it(
    "should switch to a branch that exists only upstream",
    () => {
      const result = runSous(projectRoot, env, "repo", "link", "demo-recipes", "--branch", "feature");
      expect(result.status, result.output).toBe(0);
      expect(branchOf()).toBe("feature");
      expect(result.output).toContain("Switched to the branch 'feature'.");
      expect(result.output).toMatch(/Merged into origin\/main\s*: no/);
    },
    CLI_TIMEOUT
  );

  /**
   * A branch upstream does not have is git's to refuse; its message comes
   * through under a line naming the step, and the checkout is not changed.
   */
  it(
    "should pass git's refusal through for a branch that does not exist",
    () => {
      const result = runSous(projectRoot, env, "repo", "link", "demo-recipes", "--branch", "nope");
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("Fetching the branch 'nope' from origin failed.");
      expect(result.output).toContain("git said:");
      expect(branchOf()).toBe("feature");
    },
    CLI_TIMEOUT
  );

  /**
   * The three branch flags exclude each other, and `--from` means nothing
   * without a flag that creates a branch; oclif refuses both before anything
   * runs.
   */
  it(
    "should refuse conflicting branch flags and a lone --from",
    () => {
      const both = runSous(
        projectRoot,
        env,
        "repo",
        "link",
        "demo-recipes",
        "--branch",
        "main",
        "--generate-branch"
      );
      expect(both.status).not.toBe(0);
      expect(both.output).toContain("cannot also be provided");

      const lone = runSous(projectRoot, env, "repo", "link", "demo-recipes", "--from", "main");
      expect(lone.status).not.toBe(0);
      expect(lone.output).toContain("--create-branch");
      expect(lone.output).toContain("--generate-branch");
    },
    CLI_TIMEOUT
  );

  /**
   * `--create-branch` starts the new branch from upstream's default branch,
   * not from whatever is checked out, so it never stacks on the feature branch
   * the checkout was left on. A second run with the same name is git's to
   * refuse.
   *
   * sous repo link demo-recipes --create-branch my-edit
   */
  it(
    "should create a branch from the default branch and pass git's refusal through",
    () => {
      const result = runSous(
        projectRoot,
        env,
        "repo",
        "link",
        "demo-recipes",
        "--create-branch",
        "my-edit"
      );
      expect(result.status, result.output).toBe(0);
      expect(branchOf()).toBe("my-edit");
      expect(git(checkout, "rev-parse", "HEAD")).toBe(git(author, "rev-parse", "main"));
      expect(result.output).toContain("from origin/main");

      git(checkout, "switch", "-q", "feature");
      const again = runSous(
        projectRoot,
        env,
        "repo",
        "link",
        "demo-recipes",
        "--create-branch",
        "my-edit"
      );
      expect(again.status).not.toBe(0);
      expect(again.output).toContain("Creating the branch 'my-edit' from origin/main failed.");
      expect(again.output).toContain("already exists");
    },
    CLI_TIMEOUT
  );

  /**
   * `--generate-branch` names the branch sous/edit-<date>-<time> and prints
   * the name; `--from` picks its base.
   */
  it(
    "should create a branch with a generated name from the --from base",
    () => {
      const result = runSous(
        projectRoot,
        env,
        "repo",
        "link",
        "demo-recipes",
        "--generate-branch",
        "--from",
        "feature"
      );
      expect(result.status, result.output).toBe(0);
      expect(branchOf()).toMatch(/^sous\/edit-\d{8}-\d{4}$/);
      expect(result.output).toContain(`Created the branch '${branchOf()}'`);
      expect(git(checkout, "rev-parse", "HEAD")).toBe(git(author, "rev-parse", "feature"));
    },
    CLI_TIMEOUT
  );

  /**
   * `--latest` lists the work it would discard, and without a terminal it
   * fails naming the flag that answers the question, changing nothing. With
   * `--yes` it makes the default branch match upstream's and leaves every
   * other branch alone.
   *
   * sous repo link demo-recipes --latest --yes
   */
  it(
    "should list what --latest discards, ask, and then update only that branch",
    () => {
      git(checkout, "switch", "-q", "main");
      git(checkout, "config", "user.email", "tests@example.com");
      git(checkout, "config", "user.name", "Sous Tests");
      commitFile(checkout, "local.txt", "local\n", "a local commit");
      fs.writeFileSync(path.join(checkout, "README.md"), "edited\n", "utf8");
      const localHead = git(checkout, "rev-parse", "HEAD");
      const myEdit = git(checkout, "rev-parse", "my-edit");

      const blocked = runSous(
        projectRoot,
        env,
        "repo",
        "link",
        "demo-recipes",
        "--latest",
        "--non-interactive"
      );
      expect(blocked.status).not.toBe(0);
      expect(blocked.output).toContain("a local commit");
      expect(blocked.output).toContain("README.md");
      expect(blocked.output).toContain("--yes");
      expect(git(checkout, "rev-parse", "HEAD")).toBe(localHead);

      const result = runSous(projectRoot, env, "repo", "link", "demo-recipes", "--latest", "--yes");
      expect(result.status, result.output).toBe(0);
      expect(branchOf()).toBe("main");
      expect(git(checkout, "rev-parse", "HEAD")).toBe(git(author, "rev-parse", "main"));
      expect(fs.existsSync(path.join(checkout, "later.txt"))).toBe(true);
      expect(git(checkout, "status", "--porcelain", "--untracked-files=no")).toBe("");
      expect(git(checkout, "rev-parse", "my-edit")).toBe(myEdit);
      expect(result.output).toMatch(/Behind origin\/main\s*: 0 commits/);
    },
    CLI_TIMEOUT
  );

  /**
   * With upstream unreachable, a plain link still succeeds and warns that the
   * checkout may have diverged since it was last fetched, with git's reason;
   * `--latest` fails instead, because it cannot do what it was asked.
   */
  it(
    "should warn when upstream cannot be reached, and fail --latest",
    () => {
      fs.renameSync(bareRepo, movedBare);
      try {
        const plain = runSous(projectRoot, env, "repo", "link", "demo-recipes");
        expect(plain.status, plain.output).toBe(0);
        expect(plain.output).toContain("Could not reach upstream;");
        expect(plain.output).toContain("may have diverged since");
        expect(plain.output).toContain("Git said:");

        const latest = runSous(
          projectRoot,
          env,
          "repo",
          "link",
          "demo-recipes",
          "--latest",
          "--yes"
        );
        expect(latest.status).not.toBe(0);
        expect(latest.output).toContain("Fetching the branch 'main' from origin failed.");
      } finally {
        fs.renameSync(movedBare, bareRepo);
      }
    },
    CLI_TIMEOUT
  );

  /**
   * A --global checkout is shared by every project on the machine, so
   * changing its branch says so.
   */
  it(
    "should say a --global checkout's branch change affects every project",
    () => {
      const result = runSous(
        projectRoot,
        env,
        "repo",
        "link",
        "demo-recipes",
        "--global",
        "--branch",
        "feature"
      );
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain("SHARED by every project on this machine");
      const globalCheckout = linkedPath(path.join(root, "sous-home"));
      expect(git(globalCheckout, "symbolic-ref", "--short", "HEAD")).toBe("feature");
    },
    CLI_TIMEOUT
  );
});
