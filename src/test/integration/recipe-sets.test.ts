import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { gitIn, writeFixtureFile } from "../utils/fixture-repo.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");

/** Per-test budget: every one of these boots the real CLI in a subprocess. */
const CLI_TIMEOUT = 90_000;

type RunResult = { stdout: string; stderr: string; status: number | null };

let tmp: TmpDir;
/** The recipe repository publishing the set, released by the real CLI. */
let recipeRepo: string;
/** The project that trusts the repository and has subscribed to nothing. */
let projectRoot: string;
/** The machine-wide sous home, which holds the store and the index cache. */
let sousHome: string;

/**
 * Runs `sous <args...>` through the real published bin, from `cwd`, with the
 * machine-wide sous home pointed into this test's temporary directory and the
 * project-locating variables stripped, so nothing here reads or writes outside
 * the temp tree.
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

/** Everything a run printed, without color codes and with every wrap undone. */
function flat(result: RunResult): string {
  // eslint-disable-next-line no-control-regex
  return `${result.stdout}${result.stderr}`
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\s+/g, " ");
}

/** One recipe manifest of the set repository, as YAML. */
function recipeYaml(key: string, extra = ""): string {
  const [namespace, name] = key.split("/");
  return `formatVersion: 1\nnamespace: ${namespace}\nname: ${name}\nversion: 1.0.0\n${extra}`;
}

/** A variable definition block for a recipe manifest, as YAML list items. */
function variableYaml(name: string, prompt: string): string {
  return (
    `  - name: ${name}\n    type: string\n    prompt: ${prompt}\n` +
    `    description: What the ${name} setting is for.\n    example: sample\n` +
    `    default: sample\n`
  );
}

/**
 * Writes the set repository: `omakase/house` bundles the whole `workflow`
 * namespace as co-subscriptions and takes `tools/lint` as a build dependency,
 * and asks nothing itself; every recipe it brings in asks one question.
 */
function writeSetRepository(directory: string): void {
  writeFixtureFile(
    path.join(directory, "sous.repo.yaml"),
    "formatVersion: 1\nname: house-recipes\nnamespaces:\n  omakase: {}\n  workflow: {}\n" +
      "  tools: {}\nrecipes:\n  - recipes/omakase/house\n  - recipes/workflow/notes\n" +
      "  - recipes/workflow/review\n  - recipes/tools/lint\n"
  );
  writeFixtureFile(
    path.join(directory, "recipes/omakase/house/sous.recipe.yaml"),
    recipeYaml(
      "omakase/house",
      "description: The house set.\nsubscribes:\n  - workflow\ndepends:\n  - tools/lint\n"
    )
  );
  writeFixtureFile(path.join(directory, "recipes/omakase/house/README.md"), "The set.\n");

  for (const [key, variable] of [
    ["workflow/notes", "notesDir"],
    ["workflow/review", "reviewDepth"],
    ["tools/lint", "lintLevel"],
  ] as const) {
    const name = key.split("/")[1]!;
    writeFixtureFile(
      path.join(directory, `recipes/${key}/sous.recipe.yaml`),
      recipeYaml(
        key,
        "contents:\n  - kind: skills\n    include:\n      - skills/**/*.md\n" +
          `variables:\n${variableYaml(variable, `What should ${variable} be?`)}`
      )
    );
    writeFixtureFile(
      path.join(directory, `recipes/${key}/skills/${name}/SKILL.md`),
      `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\nBody.\n`
    );
  }
}

/**
 * Writes the smallest project sous supports, with the built-in repository
 * switched off so nothing here reaches the network.
 */
function makeProject(directory: string): void {
  const sousDir = path.join(directory, ".sous");
  writeFixtureFile(
    path.join(sousDir, "sous.config.js"),
    [
      "// The smallest sous config a test project needs.",
      "export const config = {",
      "  version: 1,",
      '  name: "sets",',
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
    ].join("\n")
  );
  writeFixtureFile(path.join(sousDir, "prompts", "CLAUDE.md"), "# sets\n");
  writeFixtureFile(
    path.join(sousDir, "conf.d", "100-offline.json"),
    JSON.stringify({ repos: { "sous-recipes": { enabled: false } } }, null, 2)
  );
}

/**
 * A preset set described before anyone subscribes to it. `sous repo release`
 * records, in the index, how each of the set's dependencies is declared and
 * the questions every version asks, so a project that has installed nothing
 * sees the whole set and every question from the index alone.
 */
describe("a recipe set described from the index", () => {
  beforeAll(() => {
    tmp = makeTmpDir("sous-sets-");
    sousHome = path.join(tmp.path, "sous-home");
    recipeRepo = path.join(tmp.path, "house-recipes");
    projectRoot = path.join(tmp.path, "project");

    writeSetRepository(recipeRepo);
    gitIn(recipeRepo, "init", "--quiet", "--initial-branch", "main");
    gitIn(recipeRepo, "config", "user.name", "Sous Test");
    gitIn(recipeRepo, "config", "user.email", "test@example.invalid");
    gitIn(recipeRepo, "config", "commit.gpgsign", "false");
    gitIn(recipeRepo, "config", "tag.gpgsign", "false");
    gitIn(recipeRepo, "add", "-A");
    gitIn(recipeRepo, "commit", "--quiet", "-m", "the set repository");

    const released = sous(recipeRepo, "repo", "release", "--yes");
    if (released.status !== 0) throw new Error(`repo release failed: ${flat(released)}`);

    makeProject(projectRoot);
    const added = sous(
      projectRoot,
      "repo",
      "add",
      recipeRepo,
      "--name",
      "house-recipes",
      "--trust"
    );
    if (added.status !== 0) throw new Error(`repo add failed: ${flat(added)}`);
  }, CLI_TIMEOUT);

  afterAll(() => {
    tmp.cleanup();
  });

  /**
   * The release records each dependency's declaration and kind, and each
   * version's variable definitions, in the index it commits.
   *
   * sous repo release --yes
   * // -> omakase/house@1.0.0 records workflow/notes as { declared: "workflow", kind: "subscribes" }
   */
  it("should record declarations and questions in the released index", () => {
    const index = JSON.parse(
      fs.readFileSync(path.join(recipeRepo, "sous.index.json"), "utf8")
    ) as {
      recipes: Record<
        string,
        { versions: Record<string, { dependencies?: object; variables?: object[] }> }
      >;
    };

    const house = index.recipes["omakase/house"]!.versions["1.0.0"]!;
    expect(house.dependencies).toEqual({
      "tools/lint": { version: "1.0.0", declared: "tools/lint", kind: "depends" },
      "workflow/notes": { version: "1.0.0", declared: "workflow", kind: "subscribes" },
      "workflow/review": { version: "1.0.0", declared: "workflow", kind: "subscribes" },
    });
    expect(house.variables).toEqual([]);
    expect(index.recipes["workflow/notes"]!.versions["1.0.0"]!.variables).toHaveLength(1);
  });

  /**
   * `sous recipe show` on a set nothing has installed lists what the set
   * declares (a whole namespace as co-subscriptions, a build dependency),
   * everything subscribing would install, and every question that would be
   * asked, without fetching anything and without naming any flag.
   *
   * sous recipe show omakase/house
   */
  it(
    "should show a set's members, their kinds and every question before subscribing",
    () => {
      const result = sous(projectRoot, "recipe", "show", "omakase/house");
      const text = flat(result);

      expect(result.status, text).toBe(0);
      expect(text).toContain("What it depends on");
      expect(text).toContain("the whole 'workflow' namespace");
      expect(text).toContain("co-subscription");
      expect(text).toContain("build dependency");
      expect(text).not.toContain("not recorded");

      expect(text).toContain("What subscribing installs");
      expect(text).toContain("the subscription itself");
      expect(text).toMatch(/workflow\/review 1\.0\.0 co-subscription omakase\/house/);
      expect(text).toMatch(/tools\/lint 1\.0\.0 build dependency omakase\/house/);

      expect(text).toContain("What subscribing asks you");
      expect(text).toContain("These recipes ask 3 questions");
      for (const question of ["notesDir", "reviewDepth", "lintLevel"]) {
        expect(text).toContain(question);
      }
      expect(text).not.toContain("Not on this machine yet");
      expect(text).not.toContain("--answer");

      expect(text).toContain("The recipe's own files are not on this machine");
      expect(fs.existsSync(path.join(projectRoot, ".sous", "sous.lock.json"))).toBe(false);
    },
    CLI_TIMEOUT
  );

  /**
   * The dry run of a subscription lists the same questions, from the index,
   * with nothing in the store, instead of naming the recipes as unreadable.
   *
   * sous subscription add omakase/house --dry-run
   */
  it(
    "should list every question a subscription would ask on a dry run",
    () => {
      const result = sous(
        projectRoot,
        "subscription",
        "add",
        "omakase/house",
        "--dry-run",
        "--non-interactive"
      );
      const text = flat(result);

      expect(result.status, text).toBe(0);
      expect(text).toContain("These recipes ask 3 questions");
      expect(text).toContain("workflow/notes asks 1 question:");
      expect(text).toContain("tools/lint asks 1 question:");
      expect(text).toContain("--answer reviewDepth=<value>");
      expect(text).not.toContain("Not on this machine yet");
      expect(fs.existsSync(path.join(projectRoot, ".sous", "sous.lock.json"))).toBe(false);
    },
    CLI_TIMEOUT
  );
});
