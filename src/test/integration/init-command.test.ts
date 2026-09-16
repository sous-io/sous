/**
 * `sous init`, end to end, through the real CLI and with no network.
 *
 * The promise: run `sous init` in a directory that has never seen sous, and the
 * next `sous build` succeeds, with the core skills compiled and pinned. The
 * child process is made offline the same three ways the core-namespace test
 * uses (a `fetch` that throws, `GIT_ALLOW_PROTOCOL=file`, a dummy token), and
 * `SOUS_HOME` points inside the temp tree so nothing reaches the machine-wide
 * store.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { SOUS_VERSION } from "../../lib/package-info.js";
import { IGNORE_BLOCK_END, IGNORE_BLOCK_START } from "../../lib/repos/links.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");

/** Per-test budget: each one boots the real CLI, and a first build seeds the store. */
const CLI_TIMEOUT = 120_000;

type RunResult = { stdout: string; stderr: string; status: number | null };

let tmp: TmpDir;
let sousHome: string;
let offlineHook: string;

/** Strips ANSI color codes so assertions read plain text. */
const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * Collapses every run of whitespace to one space, so a sentence the CLI wrapped
 * across lines (it wraps at a fixed width when stdout is not a terminal) can be
 * asserted on as one sentence.
 */
const flatten = (text: string): string => text.replace(/\s+/g, " ");

/** Writes a file, creating its parent directories. Returns the full path. */
function write(filePath: string, contents: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

/** Every file under `root`, relative to it and sorted, so two snapshots compare. */
function listTree(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(path.relative(root, full));
    }
  };
  walk(root);
  return found.sort();
}

/** A fresh project directory under the temp tree. */
function freshProject(name: string): string {
  const dir = path.join(tmp.path, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Runs `sous <args...>` through the real published bin, from `cwd`, on a machine
 * that has no network and no terminal.
 */
function sous(cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}): RunResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SOUS_HOME: sousHome,
    GITHUB_TOKEN: "offline-test-token",
    GIT_ALLOW_PROTOCOL: "file",
    NODE_OPTIONS: `--import=${pathToFileURL(offlineHook).href}`,
    ...extraEnv,
  };
  delete env.SOUS_CONFIG;
  delete env.SOUS_DIR;
  delete env.SOUS_CONFD;

  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    encoding: "utf8",
    env,
  });
  return {
    stdout: strip(result.stdout ?? ""),
    stderr: strip(result.stderr ?? ""),
    status: result.status,
  };
}

beforeAll(() => {
  tmp = makeTmpDir("sous-init-command-");
  sousHome = path.join(tmp.path, "sous-home");

  offlineHook = write(
    path.join(tmp.path, "offline.mjs"),
    [
      "globalThis.fetch = async (url) => {",
      "  throw new Error(`offline: this test machine cannot reach ${url}`);",
      "};",
      "",
    ].join("\n")
  );
});

afterAll(() => {
  tmp.cleanup();
});

describe("sous init in a directory that has never seen sous", () => {
  /**
   * `sous init` should write the `.sous/` directory, run the first build, and
   * leave the project in a state where `sous build` succeeds immediately: the
   * starter prompt compiled, the core skills compiled, and `core/sous-skills`
   * pinned in the lockfile at the running sous version.
   */
  it(
    "should set the project up so that the next build succeeds",
    () => {
      const project = freshProject("fresh");

      const init = sous(project, ["init"]);
      expect(init.status, init.stdout + init.stderr).toBe(0);

      for (const relative of [
        ".sous/sous.config.js",
        ".sous/memories/AGENTS.md",
        ".sous/.env",
        ".sous/.env.local.example",
        ".sous/.gitignore",
        ".sous/sous.lock.json",
        "AGENTS.md",
        ".claude/skills/about-sous/SKILL.md",
      ]) {
        expect(fs.existsSync(path.join(project, relative)), relative).toBe(true);
      }

      expect(init.stdout).toContain("wrote .sous/sous.config.js");
      expect(init.stdout).not.toContain("package.json");
      expect(init.stdout).toContain(`pinned: core/sous-skills at version ${SOUS_VERSION}`);

      const lock = JSON.parse(
        fs.readFileSync(path.join(project, ".sous", "sous.lock.json"), "utf8")
      ) as { recipes: Record<string, { version: string }> };
      expect(lock.recipes["core/sous-skills"]?.version).toBe(SOUS_VERSION);

      const build = sous(project, ["build"]);
      expect(build.status, build.stdout + build.stderr).toBe(0);
    },
    CLI_TIMEOUT
  );

  /**
   * The ignore file should carry the sous-managed block, covering the state
   * file and the local answers file, and a `.sous/.gitignore` that already
   * held the block plus lines of its own should keep those lines and gain
   * nothing twice.
   */
  /**
   * A project that has a package.json gains sous as an exact devDependency, so
   * the version the templates were written against travels with the project
   * and a global sous hands off to it. Nothing is installed.
   */
  it(
    "should add sous to an existing package.json as a devDependency",
    () => {
      const project = freshProject("with-package-json");
      const packageJsonPath = path.join(project, "package.json");
      fs.writeFileSync(packageJsonPath, '{\n  "name": "with-package-json",\n  "private": true\n}\n');

      const init = sous(project, ["init", "--no-build"]);
      expect(init.status, init.stdout + init.stderr).toBe(0);

      expect(init.stdout).toContain(`added @sous-io/sous ${SOUS_VERSION} to devDependencies in package.json`);
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
        private: boolean;
        devDependencies: Record<string, string>;
      };
      expect(pkg.private).toBe(true);
      expect(pkg.devDependencies).toEqual({ "@sous-io/sous": SOUS_VERSION });
      expect(fs.existsSync(path.join(project, "node_modules"))).toBe(false);
    },
    CLI_TIMEOUT
  );

  it(
    "should write the managed ignore block once, keeping what was there",
    () => {
      const project = freshProject("ignore");
      const ignorePath = path.join(project, ".sous", ".gitignore");
      write(
        ignorePath,
        ["scratch/", IGNORE_BLOCK_START, "sous.state.json", IGNORE_BLOCK_END, ""].join("\n")
      );

      const init = sous(project, ["init", "--no-build"]);
      expect(init.status, init.stdout + init.stderr).toBe(0);

      const lines = fs.readFileSync(ignorePath, "utf8").split("\n");
      expect(lines[0]).toBe("scratch/");
      expect(lines.filter((line) => line === IGNORE_BLOCK_START)).toHaveLength(1);
      expect(lines.filter((line) => line === IGNORE_BLOCK_END)).toHaveLength(1);
      expect(lines).toContain("sous.state.json");
      expect(lines).toContain(".env.local");
    },
    CLI_TIMEOUT
  );

  /**
   * `--format json` should write `sous.config.json` bound to the schema for the
   * running version through `$schema`, and that config should build.
   */
  it(
    "should write a JSON config bound to the shipped schema when asked",
    () => {
      const project = freshProject("json");

      const init = sous(project, ["init", "--format", "json", "--no-build"]);
      expect(init.status, init.stdout + init.stderr).toBe(0);

      const configPath = path.join(project, ".sous", "sous.config.json");
      expect(fs.existsSync(configPath)).toBe(true);
      expect(fs.existsSync(path.join(project, ".sous", "sous.config.js"))).toBe(false);

      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as { $schema: string };
      expect(parsed.$schema).toContain(`/v${SOUS_VERSION}/sous.config.schema.json`);

      // --no-build wrote nothing beyond the setup itself.
      expect(fs.existsSync(path.join(project, "AGENTS.md"))).toBe(false);

      const build = sous(project, ["build"]);
      expect(build.status, build.stdout + build.stderr).toBe(0);
      expect(fs.existsSync(path.join(project, "AGENTS.md"))).toBe(true);
    },
    CLI_TIMEOUT
  );

  /**
   * `--dry-run` should print what would be written and write nothing at all.
   */
  it(
    "should write nothing on a dry run",
    () => {
      const project = freshProject("dry");

      const init = sous(project, ["init", "--dry-run"]);
      expect(init.status, init.stdout + init.stderr).toBe(0);
      expect(init.stdout).toContain("would write .sous/sous.config.js");
      expect(listTree(project)).toEqual([]);
    },
    CLI_TIMEOUT
  );
});

describe("sous init where sous is already set up", () => {
  /**
   * A project whose `.sous/` already holds a primary config should be refused
   * with an error naming that config, and nothing should change.
   */
  it(
    "should refuse to touch an existing setup",
    () => {
      const project = freshProject("existing");
      const configPath = write(
        path.join(project, ".sous", "sous.config.json"),
        `${JSON.stringify({ name: "Existing" }, null, 2)}\n`
      );
      const before = listTree(project);

      const init = sous(project, ["init"]);
      expect(init.status).toBe(1);
      const output = flatten(init.stdout + init.stderr);
      expect(output).toContain("Error:");
      expect(output).toContain("is already set up for sous");
      expect(output).toContain("sous.config.json");

      expect(listTree(project)).toEqual(before);
      expect(fs.readFileSync(configPath, "utf8")).toContain('"name": "Existing"');
    },
    CLI_TIMEOUT
  );

  /**
   * A directory inside a project that is already set up is a question, not an
   * error: with no terminal the run fails naming `--yes` and writes nothing,
   * and with `--yes` the nested project is set up.
   */
  it(
    "should ask before nesting a project inside another one",
    () => {
      const outer = freshProject("outer");
      write(
        path.join(outer, ".sous", "sous.config.json"),
        `${JSON.stringify({ name: "Outer" }, null, 2)}\n`
      );
      const inner = path.join(outer, "packages", "inner");
      fs.mkdirSync(inner, { recursive: true });

      const blocked = sous(inner, ["init", "--no-build"], { CI: "1" });
      expect(blocked.status).toBe(1);
      const output = flatten(blocked.stdout + blocked.stderr);
      expect(output).toContain("is inside a project that is already set up for sous");
      expect(output).toContain("--yes");
      expect(listTree(inner)).toEqual([]);

      const allowed = sous(inner, ["init", "--no-build", "--yes"], { CI: "1" });
      expect(allowed.status, allowed.stdout + allowed.stderr).toBe(0);
      expect(fs.existsSync(path.join(inner, ".sous", "sous.config.js"))).toBe(true);
    },
    CLI_TIMEOUT
  );
});

describe("the no-config error", () => {
  /**
   * A command run where no config can be found should name `sous init` as the
   * first fix, and should no longer print a config to copy by hand.
   */
  it(
    "should recommend sous init",
    () => {
      const project = freshProject("empty");

      const build = sous(project, ["build"]);
      expect(build.status).toBe(1);
      const output = flatten(build.stdout + build.stderr);
      expect(output).toContain("No sous config found");
      expect(output).toContain("run 'sous init'");
      expect(output).not.toContain("export const config");
    },
    CLI_TIMEOUT
  );
});
