/**
 * The `#memories` view, and the build's warning about memories no output
 * included. Everything runs through the real CLI against a local fixture
 * repository, with `SOUS_HOME` inside the test's temporary directory and a
 * `fetch` that throws, so nothing reaches the network or the user's home.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { buildFixtureRepo, writeFixtureFile } from "../utils/fixture-repo.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");

/** Per-test budget: each one boots the real CLI. */
const CLI_TIMEOUT = 120_000;

let tmp: TmpDir;
let sousHome: string;
let offlineHook: string;
let projectRoot: string;

/** Runs `sous <args...>` through the real bin with the store in the temporary directory. */
function sous(...args: string[]): { status: number | null; output: string } {
  const env = {
    ...process.env,
    SOUS_HOME: sousHome,
    GITHUB_TOKEN: "offline-test-token",
    NODE_OPTIONS: `--import=${pathToFileURL(offlineHook).href}`,
  };
  delete env.SOUS_CONFIG;
  delete env.SOUS_DIR;
  delete env.SOUS_CONFD;
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** Writes the project's config (with the given `recipes` block) and its instruction source. */
function configure(prompt: string, recipes: unknown = undefined, fileName = "AGENTS.md"): void {
  writeFixtureFile(
    path.join(projectRoot, ".sous", "sous.config.js"),
    [
      "export const config = {",
      '  repos: { "sous-recipes": { enabled: false } },',
      '  _vars: { projectRoot: "${sousDir}/.." },',
      recipes === undefined ? "" : `  recipes: ${JSON.stringify(recipes)},`,
      "  compilation: { targets: [{",
      `    entryPoint: "\${sousDir}/prompts/${fileName}",`,
      '    outputs: [{ destinationFile: "${projectRoot}/OUT.md" }],',
      "  }] },",
      "};",
      "",
    ].join("\n")
  );
  writeFixtureFile(path.join(projectRoot, ".sous", "prompts", fileName), prompt);
}

/** Builds the project and returns the output file and everything the build printed. */
function build(): { status: number | null; out: string; log: string } {
  fs.rmSync(path.join(projectRoot, "OUT.md"), { force: true });
  const result = sous("build", "--rebuild");
  const out = path.join(projectRoot, "OUT.md");
  return {
    status: result.status,
    out: fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "",
    log: result.output.replace(/\x1b\[[0-9;]*m/g, ""),
  };
}

beforeAll(async () => {
  tmp = makeTmpDir("sous-memories-view-");
  sousHome = path.join(tmp.path, "sous-home");
  projectRoot = path.join(tmp.path, "project");
  const fixtures = path.join(tmp.path, "fixtures");

  offlineHook = writeFixtureFile(
    path.join(tmp.path, "offline.mjs"),
    "globalThis.fetch = async (url) => { throw new Error(`offline: ${url}`); };\n"
  );

  const memory = (text: string) => ({ "memories/m.md": `${text}\n` });
  const memories = [{ kind: "memories", include: ["memories/*.md"] }];
  await buildFixtureRepo(fixtures, "fixtures", [
    // aaa/app depends on workflow/base, so base is listed first although "aaa" sorts first.
    {
      namespace: "aaa",
      name: "app",
      version: "1.0.0",
      depends: ["workflow/base"],
      dependencies: { "workflow/base": { version: "1.0.0" } },
      files: memory("APP MEMORY"),
      contents: memories,
    },
    { namespace: "workflow", name: "base", version: "1.0.0", files: memory("BASE MEMORY"), contents: memories },
    { namespace: "communication", name: "tone", version: "1.0.0", files: memory("TONE MEMORY"), contents: memories },
    // Held only through depends of the recipe below: a library, listed nowhere.
    { namespace: "support", name: "helper", version: "1.0.0", files: memory("HELPER MEMORY"), contents: memories },
    {
      namespace: "tool",
      name: "user",
      version: "1.0.0",
      depends: ["support/helper"],
      dependencies: { "support/helper": { version: "1.0.0" } },
      files: memory("USER MEMORY"),
      contents: memories,
    },
  ]);

  configure("# Project\n");
  sous("repo", "add", fixtures, "--name", "fixtures", "--trust");
  for (const ref of ["aaa/app", "workflow/base", "communication/tone", "tool/user"]) {
    const result = sous("subscription", "add", ref, "--yes", "--no-build");
    expect(result.status, result.output).toBe(0);
  }
}, CLI_TIMEOUT);

afterAll(() => {
  tmp.cleanup();
});

describe("the #memories view", () => {
  /**
   * One include line pulls in the memories of every active recipe, dependency
   * first, and none from a recipe held only through depends.
   *
   * @#memories/**\/*.md
   * // -> TONE, USER, BASE, APP in that order (each recipe as early as its dependencies and the key order allow); no HELPER; no warning
   */
  it("should include every active recipe's memories in dependency order", () => {
    configure("# Project\n\n@#memories/**/*.md\n");
    const { status, out, log } = build();

    expect(status, log).toBe(0);
    const order = ["TONE MEMORY", "USER MEMORY", "BASE MEMORY", "APP MEMORY"].map((text) =>
      out.indexOf(text)
    );
    expect(order.every((index) => index >= 0), out).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(out).not.toContain("HELPER MEMORY");
    expect(log).not.toContain("not included in any output");
  }, CLI_TIMEOUT);

  /**
   * A narrower glob selects by recipe, and an exact virtual path includes one file.
   *
   * @#memories/communication/**\/*.md and @#memories/workflow/base/m.md
   * // -> TONE and BASE only
   */
  it("should select by recipe with a narrower glob and by exact virtual path", () => {
    configure(
      "@#memories/communication/**/*.md\n\n@#memories/workflow/base/m.md\n",
      { memories: { exclude: ["aaa/app", "tool/user"] } }
    );
    const { status, out, log } = build();

    expect(status, log).toBe(0);
    expect(out).toContain("TONE MEMORY");
    expect(out).toContain("BASE MEMORY");
    expect(out).not.toContain("APP MEMORY");
  }, CLI_TIMEOUT);

  /**
   * `recipes.memories.first` moves matching recipes to the front.
   *
   * first: ["tool/*"] -> USER, then BASE, APP, TONE
   */
  it("should put recipes matching first at the front", () => {
    configure("@#memories/**/*.md\n", { memories: { first: ["tool/*"] } });
    const { out, log } = build();

    expect(log).not.toContain("Error:");
    expect(out.indexOf("USER MEMORY")).toBeLessThan(out.indexOf("BASE MEMORY"));
    expect(out.indexOf("BASE MEMORY")).toBeLessThan(out.indexOf("APP MEMORY"));
  }, CLI_TIMEOUT);

  /**
   * `recipes.memories.exclude` drops recipes from the view, and an exact path
   * the view does not list is an error naming what it lists.
   *
   * exclude: ["tool/*"] -> USER is not in the output
   */
  it("should leave out excluded recipes", () => {
    configure("@#memories/**/*.md\n", { memories: { exclude: ["tool/*"] } });
    const { status, out, log } = build();

    expect(status, log).toBe(0);
    expect(out).not.toContain("USER MEMORY");
    expect(out).toContain("TONE MEMORY");

    configure("@#memories/tool/user/m.md\n", { memories: { exclude: ["tool/*"] } });
    const missing = build();
    expect(missing.status).toBe(1);
    expect(missing.log).toContain('The view "#memories" lists no file at "tool/user/m.md"');
  }, CLI_TIMEOUT);

  /**
   * A view is a list that may be empty: a glob over it that selects nothing
   * includes nothing and does not fail the build, unlike a path glob.
   *
   * @#memories/**\/*.md with every recipe excluded -> exit 0, no error
   */
  it("should not fail the build when the view is empty", () => {
    configure("# Only this\n\n@#memories/**/*.md\n", { memories: { exclude: ["*/*"] } });
    const { status, out, log } = build();

    expect(status, log).toBe(0);
    expect(out).toContain("# Only this");
    expect(log).not.toContain("Error:");
    expect(log).not.toContain("not included in any output");
  }, CLI_TIMEOUT);
});

describe("the unincluded-memory warning", () => {
  /**
   * A full build warns once, naming every memory an active recipe publishes
   * that no output included, and the two ways to fix it.
   *
   * only @#memories/workflow/**\/*.md included
   * // -> warning lists aaa/app, communication/tone and tool/user, not workflow/base
   */
  it("should name every memory no output included and how to fix it", () => {
    configure("@#memories/workflow/**/*.md\n");
    const { status, log } = build();

    expect(status, log).toBe(0);
    expect(log).toContain("3 memories published by your subscribed recipes are not included");
    expect(log).toContain("aaa/app: memories/m.md");
    expect(log).toContain("communication/tone: memories/m.md");
    expect(log).toContain("tool/user: memories/m.md");
    expect(log).not.toContain("workflow/base: memories/m.md");
    expect(log).toContain('"@#memories/**/*.md"');
    expect(log).toContain("recipes.memories.exclude");
    expect(log).not.toContain("support/helper");
  }, CLI_TIMEOUT);

  /**
   * An exact path counts as including the file, and an excluded recipe never warns.
   *
   * include communication/tone's file by path, exclude aaa/app and tool/user
   * // -> no warning
   */
  it("should stay silent when memories are included by any route or excluded", () => {
    configure(
      "@#memories/workflow/base/m.md\n\n@~communication/tone/memories/m.md\n",
      { memories: { exclude: ["aaa/app", "tool/user"] } }
    );
    const { status, log } = build();

    expect(status, log).toBe(0);
    expect(log).not.toContain("not included in any output");
  }, CLI_TIMEOUT);
});
