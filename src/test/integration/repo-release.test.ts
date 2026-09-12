import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { commitAll, git, initRepo, writeFile } from "../utils/git-repo.js";
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
 * fake provider CLI is put at the front of PATH. The machine-wide sous home
 * is redirected into the temp tree.
 */
function runSous(...args: string[]): RunResult {
  const childEnv = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    // The machine-wide sous home goes in the temp tree, so nothing here
    // reads or writes the home directory of whoever runs the suite.
    SOUS_HOME: path.join(tmp.path, "sous-home"),
  };
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
/** Adds a second recipe to the repository, listed by its repo manifest. */
function addSecondRecipe(): void {
  writeFile(
    recipeRepo,
    "recipes/core/other/sous.recipe.yaml",
    "formatVersion: 1\nnamespace: core\nname: other\nversion: 1.0.0\n" +
      "description: A second recipe.\ncontents:\n  - kind: skills\n    include:\n" +
      "      - skills/**/*.md\n"
  );
  writeFile(recipeRepo, "recipes/core/other/skills/other.md", "second\n");
  addRecipeToRepoManifest("recipes/core/other");
  commitAll(recipeRepo, "add a second recipe");
}

/** Adds a third recipe, which nothing ever publishes, for the sibling rule. */
function addThirdRecipe(): void {
  writeFile(
    recipeRepo,
    "recipes/core/fresh/sous.recipe.yaml",
    "formatVersion: 1\nnamespace: core\nname: fresh\nversion: 1.0.0\n" +
      "description: A recipe nothing has published yet.\ncontents:\n  - kind: skills\n" +
      "    include:\n      - skills/**/*.md\n"
  );
  writeFile(recipeRepo, "recipes/core/fresh/skills/fresh.md", "fresh\n");
  addRecipeToRepoManifest("recipes/core/fresh");
  commitAll(recipeRepo, "add a third recipe");
}

/** Appends one recipe folder to the repository manifest's `recipes` list. */
function addRecipeToRepoManifest(recipePath: string): void {
  const manifestPath = path.join(recipeRepo, "sous.repo.yaml");
  const text = fs.readFileSync(manifestPath, "utf8");
  fs.writeFileSync(manifestPath, `${text.trimEnd()}\n  - ${recipePath}\n`, "utf8");
}

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
   * A dry run prints the whole plan and stops: no bump, no index, no commit and
   * no tag.
   */
  it(
    "should print the plan and change nothing on a dry run",
    () => {
      const result = runSous("repo", "release", "--dry-run");

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("core/example");
      expect(result.stdout).toContain("core/example@0.1.0");
      expect(result.stdout).toContain("Nothing was written");
      expect(git(recipeRepo, "tag", "--list")).toBe("");
      expect(readIndex().recipes).toEqual({});
    },
    CLI_TIMEOUT
  );

  /**
   * The confirmation is a real gate: a run with no terminal cannot answer it,
   * so it fails naming the flag that would have.
   */
  it(
    "should refuse to publish with no terminal and no --yes",
    () => {
      const result = runSous("repo", "release");

      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain("--yes");
      expect(git(recipeRepo, "tag", "--list")).toBe("");
    },
    CLI_TIMEOUT
  );

  /**
   * `--non-interactive` is a global flag, and the authoring commands carry it
   * too even though they discover no project config. It is accepted rather than
   * rejected as unknown, the run fails naming the flag that would have answered
   * the confirmation, and the command's own help is printed underneath.
   *
   * sous repo release --non-interactive   // -> non-zero, names --yes
   */
  it(
    "should accept --non-interactive and refuse to publish, naming --yes",
    () => {
      const result = runSous("repo", "release", "--non-interactive");
      const output = result.stdout + result.stderr;

      expect(result.status).toBe(1);
      expect(output).not.toContain("Nonexistent flag");
      expect(output).toContain("--non-interactive");
      expect(output).toContain("--yes");
      // The command's own help, printed underneath the error.
      expect(result.stderr).toContain("USAGE");
      expect(git(recipeRepo, "tag", "--list")).toBe("");
    },
    CLI_TIMEOUT
  );

  /**
   * The default developer run does the whole job: it regenerates the index,
   * commits it, and tags that commit. The recipe has never been tagged, so
   * nothing is bumped; its declared version is the one being published.
   */
  it(
    "should regenerate, commit and tag in one run",
    () => {
      const result = runSous("repo", "release", "--yes");

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("Created the tag core/example@0.1.0");
      expect(git(recipeRepo, "tag", "--list")).toContain("core/example@0.1.0");
      expect(git(recipeRepo, "log", "-1", "--format=%s")).toBe(
        "Release core/example@0.1.0"
      );
      expect(git(recipeRepo, "status", "--porcelain")).toBe("");

      const versions = readIndex().recipes["core/example"]!.versions;
      expect(Object.keys(versions)).toEqual(["0.1.0"]);
      expect(versions["0.1.0"]!.tag).toBe("core/example@0.1.0");
      expect(versions["0.1.0"]!.hash).toMatch(/^sha256-[0-9a-f]{64}$/);
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

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("is current");
    },
    CLI_TIMEOUT
  );

  /**
   * A recipe nobody has touched since its tag is not re-released; a published
   * version that says the same thing as the one before it is noise.
   */
  it(
    "should release nothing when nothing has changed",
    () => {
      const result = runSous("repo", "release", "--yes");

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("has changed since the tag");
      expect(git(recipeRepo, "tag", "--list")).toBe("core/example@0.1.0");
    },
    CLI_TIMEOUT
  );

  /**
   * A changed recipe whose version still equals its last tag is patch-bumped,
   * committed and tagged.
   */
  it(
    "should patch-bump a changed recipe and publish it",
    () => {
      writeFile(recipeRepo, "recipes/core/example/skills/one.md", "edited once\n");
      commitAll(recipeRepo, "edit the example recipe");

      const result = runSous("repo", "release", "--yes");

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("core/example: 0.1.0 becomes 0.1.1");
      expect(git(recipeRepo, "tag", "--list")).toContain("core/example@0.1.1");
      expect(git(recipeRepo, "log", "-1", "--format=%s")).toBe(
        "Release core/example@0.1.1"
      );

      const manifest = fs.readFileSync(
        path.join(recipeRepo, "recipes/core/example/sous.recipe.yaml"),
        "utf8"
      );
      expect(manifest).toContain("version: 0.1.1");
      // The manifest is hand-written and mostly comments, so a bump gives it
      // back looking the way its author left it.
      expect(manifest).toContain("# A recipe manifest: one publishable unit");
    },
    CLI_TIMEOUT
  );

  /**
   * `--bump` says how far to raise a changed recipe, instead of a patch step.
   */
  it(
    "should raise a changed recipe by the level --bump names",
    () => {
      writeFile(recipeRepo, "recipes/core/example/skills/one.md", "edited twice\n");
      commitAll(recipeRepo, "edit the example recipe again");

      const result = runSous("repo", "release", "--yes", "--bump", "minor");

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("core/example: 0.1.1 becomes 0.2.0");
      expect(git(recipeRepo, "tag", "--list")).toContain("core/example@0.2.0");
    },
    CLI_TIMEOUT
  );

  /**
   * `--ci` is the preset a merge runs: it raises nothing, and a change nobody
   * raised a version for is an error naming the manifest that has to change.
   */
  it(
    "should fail under --ci when a changed recipe was never bumped",
    () => {
      writeFile(recipeRepo, "recipes/core/example/skills/one.md", "edited a third time\n");
      commitAll(recipeRepo, "edit without raising the version");

      const result = runSous("repo", "release", "--ci");

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("Raise the version");
      expect(git(recipeRepo, "tag", "--list")).not.toContain("core/example@0.2.1");

      // Put the recipe back where the last release left it.
      git(recipeRepo, "revert", "--no-edit", "HEAD");
    },
    CLI_TIMEOUT
  );

  /**
   * `--include-unchanged` releases everything in scope, whether it changed or
   * not, which is how a repository is re-cut deliberately.
   */
  it(
    "should release an unchanged recipe with --include-unchanged",
    () => {
      const result = runSous("repo", "release", "--yes", "--include-unchanged");

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("core/example: 0.2.0 becomes 0.2.1");
      expect(git(recipeRepo, "tag", "--list")).toContain("core/example@0.2.1");
    },
    CLI_TIMEOUT
  );

  /**
   * On a branch other than the default one, a release bumps and commits but
   * cuts no tags: tags are cut on the default branch, by the merge.
   */
  it(
    "should bump and commit but cut no tags on a branch",
    () => {
      // Give the clone an `origin/HEAD`, which is where the default branch name
      // comes from; a repository created locally has none.
      git(recipeRepo, "update-ref", "refs/remotes/origin/main", "HEAD");
      git(recipeRepo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      git(recipeRepo, "checkout", "--quiet", "-b", "feature");

      writeFile(recipeRepo, "recipes/core/example/skills/one.md", "edited on a branch\n");
      commitAll(recipeRepo, "edit on a branch");

      const before = git(recipeRepo, "tag", "--list");
      const result = runSous("repo", "release", "--yes");

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("core/example: 0.2.1 becomes 0.2.2");
      expect(result.stdout).toContain("tags are cut on the");
      expect(git(recipeRepo, "tag", "--list")).toBe(before);
      expect(git(recipeRepo, "log", "-1", "--format=%s")).toBe(
        "Release core/example@0.2.2"
      );
    },
    CLI_TIMEOUT
  );

  /**
   * `--tag` forces the tags to be cut where the branch rule would have skipped
   * them, which is the escape hatch for a repository with no CI.
   */
  it(
    "should cut the tags on a branch when --tag says so",
    () => {
      const result = runSous("repo", "release", "--yes", "--tag");

      // Nothing changed since the release above, so this run has the version it
      // already committed to publish: its tag is still missing.
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(git(recipeRepo, "tag", "--list")).toContain("core/example@0.2.2");

      git(recipeRepo, "checkout", "--quiet", "main");
      git(recipeRepo, "merge", "--quiet", "--ff-only", "feature");
    },
    CLI_TIMEOUT
  );

  /**
   * Scope: `--recipe` and `--namespace` narrow a run to part of the repository,
   * and everything outside the scope is named as left alone.
   */
  it(
    "should release only what the scope names",
    () => {
      addSecondRecipe();

      const scoped = runSous("repo", "release", "--yes", "--recipe", "core/other");
      expect(scoped.status, scoped.stdout + scoped.stderr).toBe(0);
      expect(git(recipeRepo, "tag", "--list")).toContain("core/other@1.0.0");

      writeFile(recipeRepo, "recipes/core/other/skills/other.md", "changed\n");
      writeFile(recipeRepo, "recipes/core/example/skills/one.md", "changed too\n");
      commitAll(recipeRepo, "edit both recipes");

      const byRecipe = runSous("repo", "release", "--yes", "--recipe", "core/other");
      expect(byRecipe.status, byRecipe.stdout + byRecipe.stderr).toBe(0);
      expect(byRecipe.stdout).toContain("core/other: 1.0.0 becomes 1.0.1");
      expect(byRecipe.stdout).toContain("core/example: it is outside this release's scope.");
      expect(git(recipeRepo, "tag", "--list")).toContain("core/other@1.0.1");
      expect(git(recipeRepo, "tag", "--list")).not.toContain("core/example@0.2.3");

      const byNamespace = runSous("repo", "release", "--yes", "--namespace", "core");
      expect(byNamespace.status, byNamespace.stdout + byNamespace.stderr).toBe(0);
      expect(git(recipeRepo, "tag", "--list")).toContain("core/example@0.2.3");
    },
    CLI_TIMEOUT
  );

  /**
   * A scope naming something the repository does not publish is a typo, caught
   * before anything runs.
   */
  it(
    "should refuse a scope that names nothing",
    () => {
      const result = runSous("repo", "release", "--recipe", "core/nothing", "--yes");

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("publishes no recipe called 'core/nothing'");
    },
    CLI_TIMEOUT
  );

  /**
   * Tags are cut dependency-first, so a recipe is never published before
   * something it depends on, and the index records the exact version it was
   * released against.
   */
  it(
    "should tag dependency-first and record the resolved dependency",
    () => {
      // The example recipe now depends on its sibling.
      const manifestPath = path.join(
        recipeRepo,
        "recipes/core/example/sous.recipe.yaml"
      );
      fs.writeFileSync(
        manifestPath,
        `${fs.readFileSync(manifestPath, "utf8")}depends:\n  - core/other\n`,
        "utf8"
      );
      writeFile(recipeRepo, "recipes/core/other/skills/other.md", "changed again\n");
      commitAll(recipeRepo, "declare the dependency and edit the sibling");

      const result = runSous("repo", "release", "--yes");
      expect(result.status, result.stdout + result.stderr).toBe(0);

      const other = result.stdout.indexOf("Created the tag core/other@");
      const example = result.stdout.indexOf("Created the tag core/example@");
      expect(other).toBeGreaterThanOrEqual(0);
      expect(example).toBeGreaterThan(other);

      const index = readIndex();
      const published = Object.keys(index.recipes["core/example"]!.versions).sort();
      const newest = published[published.length - 1]!;
      expect(index.recipes["core/example"]!.versions[newest]!.dependencies).toEqual({
        "core/other": { version: "1.0.2" },
      });
    },
    CLI_TIMEOUT
  );

  /**
   * A sibling dependency that has never been published cannot be depended on,
   * and the error names the tag that has to be cut.
   */
  it(
    "should refuse to release a recipe whose sibling has never been published",
    () => {
      addThirdRecipe();
      const manifestPath = path.join(
        recipeRepo,
        "recipes/core/example/sous.recipe.yaml"
      );
      const before = fs.readFileSync(manifestPath, "utf8");
      fs.writeFileSync(manifestPath, `${before}  - core/fresh\n`, "utf8");
      commitAll(recipeRepo, "depend on an unpublished sibling");

      const result = runSous("repo", "release", "--yes", "--recipe", "core/example");

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("has never been published");
      expect(result.stdout).toContain("core/fresh@1.0.0");

      git(recipeRepo, "revert", "--no-edit", "HEAD");
    },
    CLI_TIMEOUT
  );

  /**
   * A changed sibling outside the scope is not an error: the release goes
   * ahead, depending on the sibling's last published version, and says so with
   * facts a reader can check.
   */
  it(
    "should warn when a changed sibling is outside the scope",
    () => {
      writeFile(recipeRepo, "recipes/core/other/skills/other.md", "changed outside\n");
      writeFile(recipeRepo, "recipes/core/example/skills/one.md", "changed inside\n");
      commitAll(recipeRepo, "edit both, release one");

      const result = runSous("repo", "release", "--yes", "--recipe", "core/example");

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout + result.stderr).toContain(
        "has changes since 'core/other@1.0.2' that are outside this release's scope"
      );

      // Publish what was left behind, so the repository is fully released for
      // the submission tests below.
      expect(runSous("repo", "release", "--yes").status).toBe(0);
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
