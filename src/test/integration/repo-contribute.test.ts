import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { commitAll, git, writeFile } from "../utils/git-repo.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");

/** Per-test timeout: each test boots the real CLI (tsx + oclif) in a subprocess. */
const CLI_TIMEOUT = 90_000;

/** Strips ANSI escape codes, so assertions read the words and not the colors. */
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

type RunResult = { status: number | null; output: string };

let tmp: TmpDir;
let root: string;
let author: string;
let bareRemote: string;
let projectRoot: string;
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
    SOUS_HOME: path.join(root, "sous-home"),
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
  return { status: result.status, output: strip(`${result.stdout}${result.stderr}`) };
}

/** Runs sous from inside the project. */
function runSous(...args: string[]): RunResult {
  return runSousIn(projectRoot, ...args);
}

/** Every `gh` call the fake recorded, one line each, and clears the record. */
function takeGhCalls(): string {
  const log = path.join(ghState, "calls.log");
  const text = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  fs.rmSync(log, { force: true });
  return text;
}

/** The project's links map, or an empty one when there is none. */
function projectLinks(): Record<string, { path: string }> {
  const file = path.join(projectRoot, ".sous", "sous.links.json");
  if (!fs.existsSync(file)) return {};
  return (JSON.parse(fs.readFileSync(file, "utf8")) as { links: Record<string, { path: string }> })
    .links;
}

/** Where the project's link says `demo-recipes` is checked out. */
function checkout(): string {
  const link = projectLinks()["demo-recipes"];
  if (link === undefined) throw new Error("demo-recipes is not linked");
  return link.path;
}

/**
 * `sous repo contribute`, end to end through the real CLI: start a
 * contribution, find nothing to submit, start again, and finish by submitting.
 *
 * The recipe repository is a released local repository, which is both what
 * the project trusts and what the contribution clones, so nothing reaches a
 * network. For the submission, the checkout's origin is pointed at a GitHub
 * address for fetching (so the GitHub provider handles it) while pushes go to a
 * local bare repository, and the GitHub CLI is a shell script on PATH. The
 * tests share one project and run in order.
 */
describe("sous repo contribute", () => {
  beforeAll(() => {
    tmp = makeTmpDir("sous-contribute-");
    root = fs.realpathSync(tmp.path);
    author = path.join(root, "author");
    bareRemote = path.join(root, "origin.git");
    projectRoot = path.join(root, "project");
    fakeBin = path.join(root, "bin");
    ghState = path.join(root, "gh-state");
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
        'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo "[]"; exit 0; fi',
        'echo "https://github.com/owner/recipes/pull/7"',
        "exit 0",
        "",
      ].join("\n"),
      "utf8"
    );
    fs.chmodSync(gh, 0o755);

    // The recipe repository, released so it publishes an index with real tags.
    const init = runSousIn(root, "repo", "init", author, "--name", "demo-recipes", "--namespace", "demo");
    if (init.status !== 0) throw new Error(`repo init failed: ${init.output}`);
    git(author, "init", "--quiet", "--initial-branch", "main");
    git(author, "config", "user.name", "Sous Test");
    git(author, "config", "user.email", "test@example.com");
    git(author, "config", "commit.gpgsign", "false");
    git(author, "config", "tag.gpgsign", "false");
    commitAll(author, "scaffold the repository");
    const released = runSousIn(author, "repo", "release", "--yes");
    if (released.status !== 0) throw new Error(`repo release failed: ${released.output}`);

    // Where a submission pushes to; the author's repository is what is cloned.
    fs.mkdirSync(bareRemote);
    git(bareRemote, "init", "--quiet", "--bare", "--initial-branch", "main");

    // The project: offline (the built-in repository is switched off), with one
    // target so a build has something to compile.
    const sousDir = path.join(projectRoot, ".sous");
    fs.mkdirSync(path.join(sousDir, "conf.d"), { recursive: true });
    fs.writeFileSync(
      path.join(sousDir, "sous.config.json"),
      JSON.stringify(
        {
          name: "contribute",
          _vars: { projectRoot: "${sousDir}/.." },
          compilation: {
            targets: [
              {
                entryPoint: "${sousDir}/CLAUDE.md",
                outputs: [{ destinationFile: "${projectRoot}/CLAUDE.md" }],
              },
            ],
          },
        },
        null,
        2
      ),
      "utf8"
    );
    fs.writeFileSync(path.join(sousDir, "CLAUDE.md"), "# contribute\n", "utf8");
    fs.writeFileSync(
      path.join(sousDir, "conf.d", "100-offline.json"),
      JSON.stringify({ repos: { "sous-recipes": { enabled: false } } }, null, 2),
      "utf8"
    );

    const added = runSous("repo", "add", author, "--name", "demo-recipes", "--trust");
    if (added.status !== 0) throw new Error(`repo add failed: ${added.output}`);
  }, 180_000);

  afterAll(() => {
    tmp.cleanup();
  });

  /**
   * A dry run resolves a recipe reference to the repository that publishes it
   * and prints the step it would run, running none.
   *
   * sous repo contribute demo/example --dry-run
   * // -> sous repo link demo-recipes --latest --generate-branch
   */
  it(
    "should resolve a recipe to its repository and print the step without running it",
    () => {
      const result = runSous("repo", "contribute", "demo/example", "--dry-run");

      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain("sous repo link demo-recipes --latest --generate-branch");
      expect(result.output).toContain("no step was run");
      expect(projectLinks()).toEqual({});
    },
    CLI_TIMEOUT
  );

  /**
   * Starting links the repository on a new branch with a generated name, cut
   * from an up-to-date default branch.
   *
   * sous repo contribute demo-recipes
   */
  it(
    "should link the repository on a generated branch",
    () => {
      const result = runSous("repo", "contribute", "demo-recipes");

      expect(result.status, result.output).toBe(0);
      expect(git(checkout(), "symbolic-ref", "--short", "HEAD")).toMatch(
        /^sous\/edit-\d{8}-\d{4}$/
      );
      expect(result.output).toContain("What this run did");
      expect(result.output).toContain("Linked 'demo-recipes' on a new branch");
      // One banner, however many commands the run chains.
      expect(result.output.match(/Agent Configuration Manager/g)).toHaveLength(1);
    },
    CLI_TIMEOUT
  );

  /**
   * Finishing a branch that holds nothing new skips the submission without
   * asking, even with no terminal, and unlinks the repository.
   *
   * sous repo contribute demo-recipes --finish
   */
  it(
    "should skip the submission when there is nothing to submit, and unlink",
    () => {
      takeGhCalls();
      const result = runSous("repo", "contribute", "demo-recipes", "--finish");

      expect(result.status, result.output).toBe(0);
      expect(result.output).toMatch(/there is\s+nothing to submit/);
      expect(result.output).toContain("sous repo unlink demo-recipes --update");
      expect(result.output).toContain("Unlinked 'demo-recipes' and updated its pins");
      expect(result.output).not.toContain("sous repo submit");
      expect(takeGhCalls()).toBe("");
      expect(projectLinks()).toEqual({});
    },
    CLI_TIMEOUT
  );

  /**
   * With work on the branch and no terminal, the question whether to submit it
   * cannot be asked, so the run fails naming the flags that answer it, and the
   * link stays as it was.
   *
   * sous repo contribute demo-recipes --create-branch add-a-skill
   * sous repo contribute demo-recipes --finish
   * // -> fails naming --submit and --no-submit
   */
  it(
    "should fail naming --submit and --no-submit when it cannot ask",
    () => {
      const started = runSous(
        "repo",
        "contribute",
        "demo-recipes",
        "--create-branch",
        "add-a-skill"
      );
      expect(started.status, started.output).toBe(0);
      expect(git(checkout(), "symbolic-ref", "--short", "HEAD")).toBe("add-a-skill");

      writeFile(checkout(), "recipes/demo/example/skills/contributed.md", "contributed\n");
      commitAll(checkout(), "contribute a skill");
      // Fetching names GitHub, so the GitHub provider handles the proposal;
      // pushing still goes to the bare repository.
      git(checkout(), "remote", "set-url", "origin", "https://github.com/owner/recipes.git");
      git(checkout(), "remote", "set-url", "--push", "origin", bareRemote);

      const planned = runSous("repo", "contribute", "demo-recipes", "--finish", "--dry-run");
      expect(planned.status, planned.output).toBe(0);
      expect(planned.output).toContain("would ask whether to submit it");
      expect(planned.output).toContain("sous repo submit demo-recipes");
      expect(planned.output).toContain("no step was run");

      const result = runSous("repo", "contribute", "demo-recipes", "--finish");

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("1 commit that has never been pushed");
      expect(result.output).toContain("--submit");
      expect(result.output).toContain("--no-submit");
      expect(projectLinks()["demo-recipes"]).toBeDefined();
    },
    CLI_TIMEOUT
  );

  /**
   * A step that fails reports its own error, and the run then names the step
   * that failed and the ones that had completed; nothing after it runs.
   *
   * sous repo contribute demo-recipes --finish --submit
   * // -> submit fails for want of a title; the link stays
   */
  it(
    "should name the completed steps when a step fails",
    () => {
      const result = runSous("repo", "contribute", "demo-recipes", "--finish", "--submit");

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("'--title' and '--body'");
      expect(result.output).toContain("The contribution stopped");
      expect(result.output).toMatch(/Failed step\s*: Proposing what the branch holds/);
      expect(result.output).toContain("Looked for work no proposal carries yet");
      expect(projectLinks()["demo-recipes"]).toBeDefined();
    },
    CLI_TIMEOUT
  );

  /**
   * With `--submit` and the proposal's text, finishing proposes the branch,
   * then unlinks the repository, and `--remove` deletes the checkout sous
   * cloned.
   *
   * sous repo contribute demo-recipes --finish --submit --title "..." --body "..." --remove
   */
  it(
    "should submit, unlink and remove the checkout",
    () => {
      const directory = checkout();
      takeGhCalls();
      const result = runSous(
        "repo",
        "contribute",
        "demo-recipes",
        "--finish",
        "--submit",
        "--title",
        "Add a skill",
        "--body",
        "It adds a contributed skill.",
        "--remove"
      );

      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain("sous repo submit demo-recipes --title 'Add a skill'");
      expect(result.output).toContain("sous repo unlink demo-recipes --update --remove");
      expect(result.output).toContain("Proposed what the branch holds");
      expect(result.output).toContain(
        "Unlinked 'demo-recipes', updated its pins and deleted the checkout"
      );
      expect(takeGhCalls()).toContain("pr create");
      expect(git(bareRemote, "branch", "--list", "add-a-skill")).toContain("add-a-skill");
      expect(projectLinks()).toEqual({});
      expect(fs.existsSync(directory)).toBe(false);
    },
    CLI_TIMEOUT
  );

  /**
   * Finishing a repository that is not linked is refused before anything
   * runs.
   *
   * sous repo contribute demo-recipes --finish
   */
  it(
    "should refuse to finish a repository that is not linked",
    () => {
      const result = runSous("repo", "contribute", "demo-recipes", "--finish");

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("is not linked in this project's links map");
    },
    CLI_TIMEOUT
  );
});
