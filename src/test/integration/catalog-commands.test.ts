import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");

/** Per-test budget: every one of these boots the real CLI in a subprocess. */
const CLI_TIMEOUT = 90_000;

/**
 * The recipe repository these tests read: a fixture shipped inside this
 * repository, exercising every corner of a manifest. It is copied into a temp
 * directory and never written to where it lives, and because it travels with
 * the source there is nothing to detect and nothing to skip.
 */
const FIXTURE_RECIPE_REPO = path.join(
  repoRoot,
  "src",
  "test",
  "fixtures",
  "recipe-repos",
  "qa-recipes"
);

type RunResult = { stdout: string; stderr: string; status: number | null };

let tmp: TmpDir;
/** The released recipe repository every project here reads. */
let recipeRepo: string;
/** The project that subscribes to a recipe. */
let projectRoot: string;
/** A second project, linked to the repository, whose subscription needs a repository nothing trusts. */
let linkedProject: string;
/** The machine-wide sous home, which holds the store and the index cache. */
let sousHome: string;

/**
 * Runs `sous <args...>` through the real published bin, from `cwd`, with the
 * store pointed at this test's temporary directory. The `SOUS_*` project
 * variables are stripped so the child discovers its config by walking up from
 * `cwd`, and nothing here can reach the developer's own store.
 */
function sous(cwd: string, ...args: string[]): RunResult {
  const env = { ...process.env, SOUS_HOME: sousHome };
  delete env.SOUS_CONFIG;
  delete env.SOUS_DIR;
  delete env.SOUS_CONFD;
  for (const key of Object.keys(env)) {
    if (key.startsWith("SOUS_VAR_")) delete env[key];
  }
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: "utf8",
    env,
    input: "",
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/** Runs git in a directory, failing loudly when it does not succeed. */
function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Sous Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Sous Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

/** Everything a run printed, without the color codes that make matching brittle. */
function output(result: RunResult): string {
  // eslint-disable-next-line no-control-regex
  return `${result.stdout}${result.stderr}`.replace(/\[[0-9;]*m/g, "");
}

/** Reads the project's lockfile. */
function readLock(root: string): {
  recipes: Record<string, { version: string; requestedBy: string[] }>;
} {
  return JSON.parse(
    fs.readFileSync(path.join(root, ".sous", "sous.lock.json"), "utf8")
  ) as { recipes: Record<string, { version: string; requestedBy: string[] }> };
}

/** Copies a fixture directory into the temp tree. */
function copyFixtureDir(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true });
}

/**
 * Writes the smallest project sous supports: a config that names the project
 * and compiles one instruction file, plus that file's tracked source. The
 * built-in repository is switched off, so nothing in this file reaches the
 * network.
 */
function makeProject(directory: string): void {
  const sousDir = path.join(directory, ".sous");
  fs.mkdirSync(path.join(sousDir, "prompts"), { recursive: true });
  fs.writeFileSync(
    path.join(sousDir, "sous.config.js"),
    [
      "// The smallest sous config a test project needs: a name, the project",
      "// root worked out from the sousDir auto-variable, and one instruction",
      "// file to compile.",
      "export const config = {",
      "  version: 1,",
      '  name: "basic",',
      '  _vars: { projectRoot: "${sousDir}/.." },',
      "  compilation: {",
      "    targets: [",
      "      {",
      '        entryPoint: "${projectRoot}/.sous/prompts/CLAUDE.md",',
      '        outputs: [{ destinationFile: "${projectRoot}/CLAUDE.md" }],',
      "      },",
      "    ],",
      "  },",
      "};",
      "",
    ].join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(sousDir, "prompts", "CLAUDE.md"),
    "# basic\n\nThe instruction file a test project compiles.\n",
    "utf8"
  );
  fs.mkdirSync(path.join(sousDir, "conf.d"), { recursive: true });
  fs.writeFileSync(
    path.join(sousDir, "conf.d", "100-offline.json"),
    JSON.stringify({ repos: { "sous-recipes": { enabled: false } } }, null, 2),
    "utf8"
  );
}

/**
 * The browsing commands, end to end through the real CLI: what the trusted
 * repositories publish (`namespace list`, `namespace show`, `recipe list`,
 * `recipe show`) and what the project pins (`lock show`, `lock rebuild`).
 *
 * Everything runs against a local copy of the quality-assurance recipe
 * repository, released by `sous repo release` into the temp tree and read
 * through the `local` provider, so nothing here touches the network.
 */
describe("the browsing commands", () => {
  beforeAll(() => {
    tmp = makeTmpDir("sous-catalog-");
    sousHome = path.join(tmp.path, "sous-home");
    recipeRepo = path.join(tmp.path, "qa-recipes");
    projectRoot = path.join(tmp.path, "project");
    linkedProject = path.join(tmp.path, "linked-project");

    // The repository: a copy of the fixture, committed and then released, so it
    // publishes a real index with real tags and content hashes.
    copyFixtureDir(FIXTURE_RECIPE_REPO, recipeRepo);
    git(recipeRepo, "init", "-q", "-b", "main");
    // `sous repo release` below commits in a child process of its own, so the
    // identity has to live in the repository rather than in the environment of
    // the calls right here.
    git(recipeRepo, "config", "user.name", "Sous Test");
    git(recipeRepo, "config", "user.email", "test@example.invalid");
    git(recipeRepo, "config", "commit.gpgsign", "false");
    git(recipeRepo, "config", "tag.gpgsign", "false");
    git(recipeRepo, "add", "-A");
    git(recipeRepo, "commit", "-qm", "the fixture repository");

    const released = sous(recipeRepo, "repo", "release", "--yes");
    if (released.status !== 0) {
      throw new Error(`repo release failed: ${output(released)}`);
    }

    // The project: it trusts the repository and subscribes to the recipe that
    // asks every kind of question, answering all of them up front because these
    // runs have no terminal.
    makeProject(projectRoot);
    const added = sous(projectRoot, "repo", "add", recipeRepo, "--name", "qa-recipes", "--trust");
    if (added.status !== 0) throw new Error(`repo add failed: ${output(added)}`);

    const subscribed = sous(
      projectRoot,
      "subscription",
      "add",
      "workflow/qa-variables",
      "--yes",
      "--answer",
      "qaAgentName=Reviewer",
      "--answer",
      "qaTaskRoot=.sous/qa-notes",
      "--answer",
      "qaDashboardUrl=https://ci.example.invalid/teams/platform",
      "--answer",
      "qaParallelAgents=4",
      "--answer",
      "qaReviewDepth=thorough",
      "--answer",
      "qaPublishNotes=false"
    );
    if (subscribed.status !== 0) {
      throw new Error(`subscription add failed: ${output(subscribed)}`);
    }

    // The second project reads the repository from a working copy, which is how
    // a recipe's manifest is readable without anything being installed. Its
    // subscription names a recipe whose dependency lives in a repository this
    // project does not trust.
    makeProject(linkedProject);
    const trusted = sous(
      linkedProject,
      "repo",
      "add",
      recipeRepo,
      "--name",
      "qa-recipes",
      "--trust"
    );
    if (trusted.status !== 0) throw new Error(`repo add failed: ${output(trusted)}`);

    const linked = sous(linkedProject, "repo", "link", "qa-recipes", recipeRepo, "--yes");
    if (linked.status !== 0) throw new Error(`repo link failed: ${output(linked)}`);

    fs.writeFileSync(
      path.join(linkedProject, ".sous", "conf.d", "200-remote.json"),
      JSON.stringify({ subscriptions: { "quality/qa-remote-dep": {} } }, null, 2),
      "utf8"
    );
  }, CLI_TIMEOUT);

  afterAll(() => {
    tmp.cleanup();
  });

  /**
   * `sous namespace list` should show every namespace the trusted repositories
   * publish, with the number of recipes in it and how much of it the project
   * subscribes to.
   *
   * sous namespace list
   */
  it(
    "should list every namespace with its recipe count and coverage",
    () => {
      const result = sous(projectRoot, "namespace", "list");
      const text = output(result);

      expect(result.status).toBe(0);
      expect(text).toContain("Namespaces in the repositories this project trusts");
      expect(text).toMatch(/workflow\s+qa-recipes\s+2\s+some recipes/);
      expect(text).toMatch(/quality\s+qa-recipes\s+2\s+no/);
    },
    CLI_TIMEOUT
  );

  /**
   * `sous namespace show <ref>` should describe the namespace and list every
   * recipe in it, with the version each one is pinned at.
   *
   * sous namespace show workflow
   */
  it(
    "should show one namespace and the recipes in it",
    () => {
      const result = sous(projectRoot, "namespace", "show", "workflow");
      const text = output(result);

      expect(result.status).toBe(0);
      expect(text).toContain("The namespace workflow");
      expect(text).toContain("Recipes in workflow");
      expect(text).toContain("workflow/qa-helper");
      expect(text).toContain("workflow/qa-variables");
      expect(text).toContain("some recipes");
    },
    CLI_TIMEOUT
  );

  /**
   * A ref that names a recipe is not a namespace, and the command should say so
   * rather than showing something else.
   *
   * sous namespace show qa-helper   // -> exits non-zero
   */
  it(
    "should refuse a namespace ref that names a recipe",
    () => {
      const result = sous(projectRoot, "namespace", "show", "qa-helper");

      expect(result.status).not.toBe(0);
      expect(output(result)).toContain("It is the name of a recipe");
    },
    CLI_TIMEOUT
  );

  /**
   * `sous recipe list` should show every recipe published, the latest version,
   * the pinned version where there is one, and whether it is subscribed. The
   * plural spelling of the topic runs the same command.
   *
   * sous recipes list
   */
  it(
    "should list every recipe with its latest and pinned versions",
    () => {
      const result = sous(projectRoot, "recipes", "list");
      const text = output(result);

      expect(result.status).toBe(0);
      expect(text).toContain("Recipes in the repositories this project trusts");
      expect(text).toMatch(/workflow\/qa-variables\s+qa-recipes\s+0\.1\.0\s+0\.1\.0\s+yes/);
      expect(text).toMatch(/quality\/qa-pattern\s+qa-recipes\s+0\.1\.0\s+no/);
    },
    CLI_TIMEOUT
  );

  /**
   * `sous recipe show <ref>` should describe one recipe completely: where it is
   * published, its versions, its dependencies from both the manifest and the
   * index, the questions it asks with the environment variable each answer is
   * stored under, and where its files land.
   *
   * sous recipe show workflow/qa-variables
   */
  it(
    "should show one recipe in full",
    () => {
      const result = sous(projectRoot, "recipe", "show", "workflow/qa-variables");
      const text = output(result);

      expect(result.status).toBe(0);
      expect(text).toContain("workflow/qa-variables");
      expect(text).toContain("recipes/workflow/qa-variables");
      expect(text).toContain("Published versions");
      expect(text).toContain("the latest version, and the one pinned here");

      // The dependency is shown as the manifest declared it and as the index
      // resolved it when the version was released.
      expect(text).toContain("workflow/qa-helper");
      expect(text).toContain("build dependency");

      // Every question, with the name its answer is stored under. The secret's
      // definition binds an environment variable of its own.
      expect(text).toContain("SOUS_VAR_QA_DASHBOARD_URL");
      expect(text).toContain("QA_SERVICE_TOKEN");
      expect(text).toContain("Where its files land in this project");
      expect(text).toContain(path.join(projectRoot, ".claude", "skills"));
    },
    CLI_TIMEOUT
  );

  /**
   * A recipe the project has not installed is still described from its index,
   * and the command says outright that the recipe's own files are not here, so
   * nothing looks like "this recipe asks nothing".
   *
   * sous recipe show qa-pattern
   */
  it(
    "should describe a recipe that is not installed",
    () => {
      const result = sous(projectRoot, "recipe", "show", "qa-pattern");
      const text = output(result);

      expect(result.status).toBe(0);
      expect(text).toContain("quality/qa-pattern");
      expect(text).toContain("this project pins none");
      expect(text).toContain("The recipe's own files are not on this machine");
    },
    CLI_TIMEOUT
  );

  /**
   * `sous lock show` should print what the lockfile pins: the recipe, the
   * version, the repository, and who holds it. A dependency is held by the
   * recipe that required it rather than by the project.
   *
   * sous lock show
   */
  it(
    "should show what the lockfile pins and who holds it",
    () => {
      const result = sous(projectRoot, "lock", "show");
      const text = output(result);

      expect(result.status).toBe(0);
      expect(text).toContain("Recipe versions this project pins");
      expect(text).toMatch(/workflow\/qa-variables\s+0\.1\.0\s+qa-recipes\s+this project/);
      expect(text).toMatch(/workflow\/qa-helper\s+0\.1\.0\s+qa-recipes\s+workflow\/qa-variables/);
    },
    CLI_TIMEOUT
  );

  /**
   * A rebuild of a lockfile that already matches the config changes nothing,
   * and a dry run writes nothing whatever it finds.
   *
   * sous lock rebuild --dry-run
   */
  it(
    "should report no change and write nothing on a dry run",
    () => {
      const before = fs.readFileSync(
        path.join(projectRoot, ".sous", "sous.lock.json"),
        "utf8"
      );

      const result = sous(projectRoot, "lock", "rebuild", "--dry-run");
      const text = output(result);

      expect(result.status).toBe(0);
      expect(text).toContain("Nothing changed.");
      expect(text).toContain("Nothing was written");
      expect(
        fs.readFileSync(path.join(projectRoot, ".sous", "sous.lock.json"), "utf8")
      ).toBe(before);
    },
    CLI_TIMEOUT
  );

  /**
   * A rebuild recomputes the whole lockfile, so an entry nothing holds any more
   * is dropped rather than carried through. Here the entry is one no
   * subscription asks for, as a bad merge or a hand edit leaves behind.
   *
   * sous lock rebuild
   */
  it(
    "should drop a locked recipe nothing holds any more",
    () => {
      const lockPath = path.join(projectRoot, ".sous", "sous.lock.json");
      const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as {
        recipes: Record<string, unknown>;
      };
      lock.recipes["quality/qa-pattern"] = {
        repo: "qa-recipes",
        version: "0.1.0",
        hash: `sha256-${"0".repeat(64)}`,
        requestedBy: ["project"],
        kind: "subscribes",
      };
      fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2), "utf8");

      const result = sous(projectRoot, "lock", "rebuild");
      const text = output(result);

      expect(result.status).toBe(0);
      expect(text).toContain("Removing quality/qa-pattern, which nothing needs any more");

      const rebuilt = readLock(projectRoot);
      expect(Object.keys(rebuilt.recipes).sort()).toEqual([
        "workflow/qa-helper",
        "workflow/qa-variables",
      ]);
      expect(rebuilt.recipes["workflow/qa-variables"]!.requestedBy).toEqual(["project"]);
      expect(rebuilt.recipes["workflow/qa-helper"]!.requestedBy).toEqual([
        "workflow/qa-variables",
      ]);
    },
    CLI_TIMEOUT
  );

  /**
   * A rebuild never grants trust and never asks for it. A subscription whose
   * closure reaches a repository the project does not trust fails, naming the
   * repository and what needs it.
   *
   * sous lock rebuild   // -> exits non-zero, naming sous-recipes
   */
  it(
    "should refuse to rebuild when a dependency needs an untrusted repository",
    () => {
      const result = sous(linkedProject, "lock", "rebuild");
      const text = output(result);

      expect(result.status).not.toBe(0);
      expect(text).toContain("need a repository it does not trust");
      expect(text).toContain("sous-recipes");
      expect(text).toContain("sous repo add");
      expect(fs.existsSync(path.join(linkedProject, ".sous", "sous.lock.json"))).toBe(false);
    },
    CLI_TIMEOUT
  );
});
