/**
 * Codex's memories file, end to end, through the real CLI and every built-in plugin: a project
 * that turns Codex on gets `AGENTS.override.md` at its root, holding the project's own
 * `AGENTS.md` first and then the memories, written by the target marked for the `codex` harness.
 * An `AGENTS.override.md` that Sous did not write is backed up under `.sous/backups/`, warned
 * about, and overwritten (spec 16).
 *
 * The recipe comes from a local fixture repository read through the `local` provider, with
 * `SOUS_HOME` inside the test's temporary directory and a `fetch` that throws, so nothing here
 * reaches the network or the user's home directory.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { buildFixtureRepo, writeFixtureFile } from "../utils/fixture-repo.js";

import { binPath } from "../utils/sous-bin.js";

/** Per-test budget: each one boots the real CLI, some of them several times. */
const CLI_TIMEOUT = 120_000;

type RunResult = { status: number | null; output: string; stdout: string };

let tmp: TmpDir;
let sousHome: string;
let offlineHook: string;
let projectRoot: string;

/** The project's own instructions, which Codex would no longer read once the override exists. */
const AGENTS_MD = "# Project rules\n\nIndent with tabs.\n";

/** An override the person wrote by hand, before Sous. */
const HAND_WRITTEN_OVERRIDE = "My own override, written before sous.\n";

/** Runs `sous <args...>` through the real bin, from the project, with no terminal and no network. */
function sous(...args: string[]): RunResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SOUS_HOME: sousHome,
    GITHUB_TOKEN: "offline-test-token",
    GIT_ALLOW_PROTOCOL: "file",
    NODE_OPTIONS: `--import=${pathToFileURL(offlineHook).href}`,
  };
  delete env.SOUS_CONFIG;
  delete env.SOUS_DIR;
  delete env.SOUS_CONFD;
  const result = spawnSync(process.execPath, [binPath, ...args], { cwd: projectRoot, encoding: "utf8", env });
  return { status: result.status, output: `${result.stdout}${result.stderr}`, stdout: result.stdout };
}

const override = () => fs.readFileSync(path.join(projectRoot, "AGENTS.override.md"), "utf8");

/** Every file under `.sous/backups/`, relative to it. */
function backups(): string[] {
  const dir = path.join(projectRoot, ".sous", "backups");
  if (!fs.existsSync(dir)) return [];
  return (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter((entry) => fs.statSync(path.join(dir, entry)).isFile())
    .map((entry) => entry.split(path.sep).join("/"));
}

beforeAll(async () => {
  tmp = makeTmpDir("sous-codex-memories-");
  sousHome = path.join(tmp.path, "sous-home");
  projectRoot = path.join(tmp.path, "project");
  const repo = path.join(tmp.path, "fixtures");

  offlineHook = writeFixtureFile(
    path.join(tmp.path, "offline.mjs"),
    ["globalThis.fetch = async (url) => {", "  throw new Error(`offline: this test machine cannot reach ${url}`);", "};", ""].join("\n")
  );

  await buildFixtureRepo(repo, "fixtures", [
    {
      namespace: "team",
      name: "habits",
      version: "1.0.0",
      files: { "memories/habits.md": "RECIPE MEMORY: write tests first.\n" },
      contents: [{ kind: "memories", include: ["memories/*.md"] }],
    },
  ]);

  // Codex is turned on by writing its plugin's options, even as {}.
  writeFixtureFile(
    path.join(projectRoot, ".sous", "sous.config.jsonc"),
    [
      "{",
      '  "name": "Codex Memories",',
      '  "plugins": { "options": { "@sous-io/sous-plugin-codex": {} } },',
      '  "repos": { "sous-recipes": { "enabled": false } }',
      "}",
      "",
    ].join("\n")
  );
  writeFixtureFile(path.join(projectRoot, ".sous", "memories", "project.md"), "PROJECT MEMORY: say what you changed.\n");
  writeFixtureFile(path.join(projectRoot, "AGENTS.md"), AGENTS_MD);
  writeFixtureFile(path.join(projectRoot, "AGENTS.override.md"), HAND_WRITTEN_OVERRIDE);

  for (const args of [
    ["repo", "add", repo, "--name", "fixtures", "--trust"],
    ["subscription", "add", "team/habits", "--yes", "--no-build"],
  ]) {
    const result = sous(...args);
    expect(result.status, result.output).toBe(0);
  }
}, CLI_TIMEOUT);

afterAll(() => {
  tmp.cleanup();
});

describe("Codex's memories file", () => {
  /**
   * The first build finds a hand-written override: it is saved under .sous/backups/, a warning
   * names it, and Sous's file takes its place.
   *
   * sous build
   * // -> warns about AGENTS.override.md and the backup;
   * //    .sous/backups/<date>/<time>/AGENTS.override.md holds "My own override, written before sous."
   */
  it(
    "should back up, warn about and overwrite an AGENTS.override.md Sous did not write",
    () => {
      const result = sous("build");
      expect(result.status, result.output).toBe(0);
      // The warning is wrapped to the terminal's width, so compare it with its white space collapsed.
      expect(result.output.replace(/\s+/g, " ")).toMatch(/Warning: \S*AGENTS\.override\.md was not written by sous, so it was backed up/);

      const saved = backups().filter((file) => file.endsWith("/AGENTS.override.md"));
      expect(saved).toHaveLength(1);
      expect(fs.readFileSync(path.join(projectRoot, ".sous", "backups", saved[0]!), "utf8")).toBe(HAND_WRITTEN_OVERRIDE);
      expect(override()).not.toContain("My own override");
    },
    CLI_TIMEOUT
  );

  /**
   * The file holds the project's AGENTS.md first, then the project's memories, then the recipe's.
   *
   * AGENTS.override.md
   * // -> "# Project rules ... PROJECT MEMORY ... RECIPE MEMORY"
   */
  it(
    "should hold the project's AGENTS.md first, then the memories",
    () => {
      const text = override();
      const rules = text.indexOf("# Project rules");
      const project = text.indexOf("PROJECT MEMORY");
      const recipe = text.indexOf("RECIPE MEMORY");

      expect(rules).toBe(0);
      expect(project).toBeGreaterThan(rules);
      expect(recipe).toBeGreaterThan(project);
      expect(fs.readFileSync(path.join(projectRoot, "AGENTS.md"), "utf8")).toBe(AGENTS_MD);
    },
    CLI_TIMEOUT
  );

  /**
   * The compilation target is marked for the codex harness, so the engine takes it from Codex's build.
   *
   * sous config get compilation.targets --json
   * // -> { id: "memories/codex", outputs: [{ destinationFile: "${projectRoot}/AGENTS.override.md", harness: "codex", backupExisting: true }] }
   */
  it(
    "should write it from a target marked for the codex harness",
    () => {
      const result = sous("config", "get", "compilation.targets", "--json");
      expect(result.status, result.output).toBe(0);

      const targets = (JSON.parse(result.stdout) as { value: unknown }).value as Array<{
        id: string;
        outputs: Array<{ destinationFile: string; harness?: string; backupExisting?: boolean }>;
      }>;
      const codex = targets.find((target) => target.id === "memories/codex");
      expect(codex?.outputs).toEqual([{ destinationFile: "${projectRoot}/AGENTS.override.md", harness: "codex", backupExisting: true }]);
    },
    CLI_TIMEOUT
  );

  /**
   * The file is kept out of git with an anchored line in the root .gitignore, and the backups
   * folder with a line in .sous/.gitignore.
   *
   * .gitignore        // -> "/AGENTS.override.md"
   * .sous/.gitignore  // -> "backups/"
   */
  it(
    "should keep the file and the backups out of git",
    () => {
      expect(fs.readFileSync(path.join(projectRoot, ".gitignore"), "utf8").split("\n")).toContain("/AGENTS.override.md");
      expect(fs.readFileSync(path.join(projectRoot, ".sous", ".gitignore"), "utf8").split("\n")).toContain("backups/");
    },
    CLI_TIMEOUT
  );

  /**
   * A second build changes nothing and backs nothing up again: the file is now Sous's own.
   *
   * sous build   // -> no new backup; AGENTS.override.md byte for byte the same
   */
  it(
    "should not back up its own file on the next build",
    () => {
      const before = override();
      const result = sous("build");
      expect(result.status, result.output).toBe(0);
      expect(override()).toBe(before);
      expect(backups().filter((file) => file.endsWith("/AGENTS.override.md"))).toHaveLength(1);
    },
    CLI_TIMEOUT
  );
});
