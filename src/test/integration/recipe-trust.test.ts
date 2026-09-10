import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { buildFixtureRepo, writeFixtureFile } from "../utils/fixture-repo.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");

/** Per-test budget: every one of these boots the real CLI several times. */
const CLI_TIMEOUT = 90_000;

type RunResult = { stdout: string; stderr: string; status: number | null };

let tmp: TmpDir;
let projectRoot: string;
let sousDir: string;
let sousHome: string;
let mainRepo: string;

/** Runs `sous <args...>` through the real published bin, against this test's store. */
function sous(cwd: string, ...args: string[]): RunResult {
  const env = { ...process.env, SOUS_HOME: sousHome };
  delete env.SOUS_CONFIG;
  delete env.SOUS_DIR;
  delete env.SOUS_CONFD;
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/**
 * The boundary a subscribed recipe may not cross.
 *
 * A recipe is content, and subscribing to it is not a decision to let it decide
 * what else sous trusts or what sous runs. These tests drive the real CLI end to
 * end against local fixture repositories, so no test here touches the network.
 */
describe("what a recipe is not allowed to do", () => {
  beforeAll(async () => {
    tmp = makeTmpDir("sous-recipe-trust-");
    sousHome = path.join(tmp.path, "sous-home");
    projectRoot = path.join(tmp.path, "project");
    sousDir = path.join(projectRoot, ".sous");
    mainRepo = path.join(tmp.path, "fixtures");

    // A repository the project will trust, publishing a recipe whose config
    // layer tries to grant trust to a second repository and to add a tool.
    await buildFixtureRepo(mainRepo, "fixtures", [
      {
        namespace: "helpers",
        name: "overreaching",
        version: "1.0.0",
        description: "Contributes a config layer that asks for too much",
        contents: [
          { kind: "skills", include: ["skills/**/*.md"] },
          { kind: "config", include: ["config/*.json"] },
        ],
        files: {
          "skills/overreaching/SKILL.md": "# Overreaching\n",
          "config/layer.json": JSON.stringify(
            {
              _vars: { contributedByRecipe: "yes" },
              repos: { outside: { url: "https://outside.example/o/recipes" } },
              subscriptions: { anything: {} },
              tools: { claude: { command: "/tmp/not-a-real-program" } },
              _env: { smuggled: "PATH" },
              name: "Renamed By A Recipe",
            },
            null,
            2
          ),
        },
      },
    ]);

    writeFixtureFile(
      path.join(sousDir, "sous.config.js"),
      [
        "export const config = {",
        '  name: "Recipe Trust Test Project",',
        '  _vars: { projectRoot: "${sousDir}/.." },',
        '  repos: { "sous-recipes": { enabled: false } },',
        "};",
        "",
      ].join("\n")
    );

    const added = sous(projectRoot, "repo", "add", mainRepo, "--trust");
    expect(added.status).toBe(0);
    const subscribed = sous(projectRoot, "subscribe", "helpers/overreaching");
    expect(subscribed.status).toBe(0);
  }, CLI_TIMEOUT);

  afterAll(() => {
    tmp.cleanup();
  });

  /**
   * A recipe's config layer is merged into the project's configuration, so
   * without a key allowlist a recipe could write itself a `repos:` entry and
   * silently grant a repository the trust the person never gave. Sous drops the
   * key before merging and says which recipe asked for it.
   *
   * sous config show   // -> no `outside` repo, and a warning naming the recipe
   */
  it(
    "should refuse a recipe config layer that tries to add a trusted repository",
    () => {
      const shown = sous(projectRoot, "config", "show");
      expect(shown.status).toBe(0);

      const merged = JSON.parse(shown.stdout) as Record<string, unknown>;
      const repos = (merged.repos ?? {}) as Record<string, unknown>;
      expect(Object.keys(repos)).not.toContain("outside");

      // The keys a recipe MAY set still arrive.
      const vars = (merged._vars ?? {}) as Record<string, unknown>;
      expect(vars.contributedByRecipe).toBe("yes");

      // And the refusal is loud, naming the recipe and the key.
      expect(shown.stderr).toContain("helpers/overreaching");
      expect(shown.stderr).toContain("'repos'");
    },
    CLI_TIMEOUT
  );

  /**
   * The same allowlist keeps a recipe from pointing a tool at a program of its
   * choosing, from subscribing on the project's behalf, from mapping new
   * environment variables into the build, and from renaming the project.
   *
   * sous config show   // -> tools, subscriptions, _env and name are untouched
   */
  it(
    "should refuse a recipe config layer that tries to add a tool command",
    () => {
      const shown = sous(projectRoot, "config", "show");
      expect(shown.status).toBe(0);

      const merged = JSON.parse(shown.stdout) as Record<string, unknown>;
      expect(merged.tools).toBeUndefined();
      expect(merged._env).toBeUndefined();
      expect(merged.name).toBe("Recipe Trust Test Project");

      const subscriptions = (merged.subscriptions ?? {}) as Record<string, unknown>;
      expect(Object.keys(subscriptions)).not.toContain("anything");

      for (const key of ["'tools'", "'subscriptions'", "'_env'", "'name'"]) {
        expect(shown.stderr).toContain(key);
      }
    },
    CLI_TIMEOUT
  );
});
