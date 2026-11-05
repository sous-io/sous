/**
 * A project copied with `cp -r` (gh-229): the copy inherits `.sous/sous.state.json`, the list of
 * every file sous wrote. The copy's first build must treat only its own files as its outputs, and
 * never remove the original project's files.
 *
 * Every project here compiles one local template, so nothing reaches the network; `SOUS_HOME` is
 * inside the test's temporary directory.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { binPath } from "../utils/sous-bin.js";

/** Per-test budget: each test boots the real CLI several times. */
const CLI_TIMEOUT = 120_000;

type RunResult = { status: number | null; output: string };

let tmp: TmpDir;
let sousHome: string;
/** A directory outside every project, standing for a user-level output directory such as `~/.claude`. */
let outside: string;
let projectA: string;
let projectB: string;

/** Runs `sous <args...>` through the real bin, from `cwd`, with the store in this test's directory. */
function sous(cwd: string, ...args: string[]): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env, SOUS_HOME: sousHome };
  delete env.SOUS_CONFIG;
  delete env.SOUS_DIR;
  delete env.SOUS_CONFD;
  const result = spawnSync(process.execPath, [binPath, ...args], { cwd, encoding: "utf8", env });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** The same, failing the test with everything printed unless it succeeded. */
function sousOk(cwd: string, ...args: string[]): RunResult {
  const result = sous(cwd, ...args);
  expect(result.status, result.output).toBe(0);
  return result;
}

/**
 * Writes a project config whose one template is compiled to each of `destinations` (absolute, or
 * relative to the project root).
 */
function writeConfig(root: string, destinations: string[]): void {
  const outputs = destinations
    .map((dest) => `{ destinationFile: ${JSON.stringify(path.isAbsolute(dest) ? dest : `\${projectRoot}/${dest}`)} }`)
    .join(", ");
  fs.writeFileSync(
    path.join(root, ".sous", "sous.config.js"),
    [
      "export const config = {",
      '  _vars: { projectRoot: "${sousDir}/.." },',
      '  repos: { "sous-recipes": { enabled: false } },',
      "  compilation: {",
      `    targets: [{ entryPoint: "\${sousDir}/prompts/AGENTS.md", outputs: [${outputs}] }],`,
      "  },",
      "};",
      "",
    ].join("\n")
  );
}

/** Creates project A with its template and config. */
function makeProjectA(destinations: string[]): void {
  fs.mkdirSync(path.join(projectA, ".sous", "prompts"), { recursive: true });
  fs.writeFileSync(path.join(projectA, ".sous", "prompts", "AGENTS.md"), "# The project\n");
  writeConfig(projectA, destinations);
}

/** `cp -r project-a project-b`. */
function copyAToB(): void {
  fs.cpSync(projectA, projectB, { recursive: true });
}

beforeEach(() => {
  tmp = makeTmpDir("sous-copied-project-");
  sousHome = path.join(tmp.path, "sous-home");
  outside = path.join(tmp.path, "user-level");
  projectA = path.join(tmp.path, "project-a");
  projectB = path.join(tmp.path, "project-b");
});

afterEach(() => {
  tmp.cleanup();
});

describe("a project copied with cp -r", () => {
  /**
   * The copy's first build, after its outputs changed, removes its own stale copy of an output and
   * leaves the original project's file alone.
   *
   * sous build                       # in project-a: writes project-a/AGENTS.md and project-a/skills/x/SKILL.md
   * cp -r project-a project-b
   * # project-b's config now writes only OTHER.md
   * sous build                       # in project-b
   * // -> project-a/AGENTS.md and project-a/skills/x/SKILL.md still exist
   */
  it(
    "should not remove the original project's outputs",
    () => {
      makeProjectA(["AGENTS.md", "skills/x/SKILL.md"]);
      sousOk(projectA, "build");
      copyAToB();

      writeConfig(projectB, ["OTHER.md"]);
      sousOk(projectB, "build");

      expect(fs.existsSync(path.join(projectA, "AGENTS.md"))).toBe(true);
      expect(fs.existsSync(path.join(projectA, "skills", "x", "SKILL.md"))).toBe(true);
      expect(fs.existsSync(path.join(projectB, "OTHER.md"))).toBe(true);
      expect(fs.existsSync(path.join(projectB, "AGENTS.md"))).toBe(false);
    },
    CLI_TIMEOUT
  );

  /**
   * A state file written before it recorded paths relative to the project (every path absolute,
   * no `projectRoot`) is still read: its paths inside the project are the project's, and those of
   * another project are left alone.
   */
  it(
    "should not remove the original project's outputs listed by an older, absolute-path state file",
    () => {
      makeProjectA(["AGENTS.md", "skills/x/SKILL.md"]);
      sousOk(projectA, "build");

      const stateFile = path.join(projectA, ".sous", "sous.state.json");
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as {
        projectRoot?: string;
        dirs: string[];
        files: { dest: string }[];
      };
      const absolute = (p: string): string => path.resolve(projectA, p);
      delete state.projectRoot;
      state.dirs = state.dirs.map(absolute);
      state.files = state.files.map((entry) => ({ ...entry, dest: absolute(entry.dest) }));
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

      copyAToB();
      writeConfig(projectB, ["OTHER.md"]);
      sousOk(projectB, "build");

      expect(fs.existsSync(path.join(projectA, "AGENTS.md"))).toBe(true);
      expect(fs.existsSync(path.join(projectA, "skills", "x", "SKILL.md"))).toBe(true);

      // The original project still prunes its own outputs from the older state file.
      writeConfig(projectA, ["AGENTS.md"]);
      sousOk(projectA, "build");

      expect(fs.existsSync(path.join(projectA, "skills", "x", "SKILL.md"))).toBe(false);
    },
    CLI_TIMEOUT
  );

  /**
   * An output outside the project (a user-level directory) is pruned by the project that wrote
   * it, and never by a copy: neither the copy's build nor its `sous clear` removes it.
   */
  it(
    "should prune an output outside the project only in the project that wrote it",
    () => {
      const userLevel = path.join(outside, "skills", "x", "SKILL.md");
      makeProjectA(["AGENTS.md", userLevel]);
      sousOk(projectA, "build");
      expect(fs.existsSync(userLevel)).toBe(true);

      copyAToB();
      writeConfig(projectB, ["AGENTS.md"]);
      sousOk(projectB, "build");
      expect(fs.existsSync(userLevel)).toBe(true);

      sousOk(projectB, "clear", "--force");
      expect(fs.existsSync(userLevel)).toBe(true);
      expect(fs.existsSync(path.join(projectA, "AGENTS.md"))).toBe(true);

      writeConfig(projectA, ["AGENTS.md"]);
      sousOk(projectA, "build");
      expect(fs.existsSync(userLevel)).toBe(false);
    },
    CLI_TIMEOUT
  );
});
