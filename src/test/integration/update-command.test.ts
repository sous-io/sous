import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");

/** Per-test timeout: each test boots the real CLI (tsx + oclif) in a subprocess. */
const CLI_TIMEOUT = 60_000;

/** What the registry served on the loopback interface publishes. */
const REGISTRY_DOCUMENT = JSON.stringify({
  name: "@sous-io/sous",
  "dist-tags": { latest: "0.2.34" },
  versions: { "0.2.18": {}, "0.2.30": {}, "0.2.34": {} },
});

type RunResult = { stdout: string; stderr: string; status: number | null };

let tmp: TmpDir;
let server: http.Server;
let registry: string;
let fakeBin: string;
let calls: string;
let globalRoot: string;

/**
 * Runs `sous <args...>` through the real published bin, asynchronously so the
 * registry this process serves can answer it. `npm`, `pnpm` and `yarn` are
 * shell scripts at the front of PATH: npm answers `root -g` with a global root
 * in the temp tree and records every other call, and the other two are not
 * installed. Standard input is not a terminal, so no question can be asked.
 */
function runSous(cwd: string, ...args: string[]): Promise<RunResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    SOUS_HOME: path.join(tmp.path, "sous-home"),
    npm_config_registry: registry,
    FAKE_CALLS: calls,
    FAKE_GLOBAL_ROOT: globalRoot,
  };
  for (const name of ["SOUS_CONFIG", "SOUS_DIR", "SOUS_CONFD", "SOUS_NO_DELEGATE", "CI"]) {
    delete env[name];
  }
  delete env.NPM_CONFIG_REGISTRY;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [binPath, ...args], { cwd, env, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdin.end();
    child.on("close", (status) => resolve({ stdout, stderr, status }));
  });
}

/** Every recorded call, one line each (`<tool> <args> @ <cwd>`), clearing the record. */
function takeCalls(): string[] {
  const text = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "";
  fs.rmSync(calls, { force: true });
  return text.split("\n").filter((line) => line.length > 0);
}

/** Output with colors removed and every run of whitespace collapsed. */
function flat(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ");
}

/** Writes an executable shell script. */
function writeScript(file: string, lines: string[]): void {
  fs.writeFileSync(file, ["#!/bin/sh", ...lines, ""].join("\n"), "utf8");
  fs.chmodSync(file, 0o755);
}

/** Writes a package.json into `dir`, creating it. */
function writePackage(dir: string, pkg: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg), "utf8");
}

/**
 * The real `sous update` command, end to end through bin/run.js: its flags,
 * its wiring to the registry, the package managers and the build, and the
 * hand-off it skips. The registry is a server this test runs on 127.0.0.1,
 * reached through `npm_config_registry`, and every package manager is a
 * script in the temp tree, so nothing reaches a network or a real install.
 */
describe("the sous update command", () => {
  beforeAll(async () => {
    tmp = makeTmpDir("sous-update-command-");
    fakeBin = path.join(tmp.path, "bin");
    calls = path.join(tmp.path, "calls.log");
    globalRoot = path.join(tmp.path, "npm-global", "lib", "node_modules");
    fs.mkdirSync(fakeBin, { recursive: true });

    writeScript(path.join(fakeBin, "npm"), [
      'if [ "$1" = "root" ]; then echo "$FAKE_GLOBAL_ROOT"; exit 0; fi',
      'printf "npm %s @ %s\\n" "$*" "$PWD" >> "$FAKE_CALLS"',
      "exit 0",
    ]);
    for (const tool of ["pnpm", "yarn"]) writeScript(path.join(fakeBin, tool), ["exit 127"]);

    server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(REGISTRY_DOCUMENT);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    tmp.cleanup();
  });

  beforeEach(() => {
    fs.rmSync(path.join(tmp.path, "npm-global"), { recursive: true, force: true });
    fs.rmSync(path.join(tmp.path, "project"), { recursive: true, force: true });
    fs.rmSync(calls, { force: true });
  });

  /** Puts a global install of sous at `version` under the fake npm's global root. */
  function installGlobal(version: string): void {
    writePackage(path.join(globalRoot, "@sous-io", "sous"), { name: "@sous-io/sous", version });
  }

  /**
   * A project declaring sous 0.2.18, with a sous config, and a copy in its
   * node_modules whose bin records each run (its arguments, its directory and
   * SOUS_NO_DELEGATE) instead of doing anything.
   */
  function makeProject(): string {
    const root = path.join(tmp.path, "project");
    writePackage(root, { name: "widget", devDependencies: { "@sous-io/sous": "0.2.18" } });
    fs.writeFileSync(path.join(root, "package-lock.json"), "{}", "utf8");
    fs.mkdirSync(path.join(root, ".sous"), { recursive: true });
    fs.writeFileSync(path.join(root, ".sous", "sous.config.json"), '{ "version": 1 }', "utf8");
    const copy = path.join(root, "node_modules", "@sous-io", "sous");
    writePackage(copy, { name: "@sous-io/sous", version: "0.2.18", bin: { sous: "bin/run.js" } });
    fs.mkdirSync(path.join(copy, "bin"), { recursive: true });
    fs.writeFileSync(
      path.join(copy, "bin", "run.js"),
      [
        'import fs from "node:fs";',
        "fs.appendFileSync(process.env.FAKE_CALLS,",
        '  `project-copy ${process.argv.slice(2).join(" ")} @ ${process.cwd()} ` +',
        "  `SOUS_NO_DELEGATE=${process.env.SOUS_NO_DELEGATE}\\n`);",
        "",
      ].join("\n"),
      "utf8"
    );
    return root;
  }

  /** A directory outside any project. */
  function outside(): string {
    const dir = path.join(tmp.path, "elsewhere");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Outside a project, `--yes` updates the global install through npm with
   * the exact version, and prints the command before it runs.
   *
   * sous update --yes (global 0.2.30) -> npm i -g @sous-io/sous@0.2.34
   */
  it(
    "should update the global install through npm under --yes",
    async () => {
      installGlobal("0.2.30");

      const result = await runSous(outside(), "update", "--yes");

      expect(result.status).toBe(0);
      expect(takeCalls()).toEqual([`npm i -g @sous-io/sous@0.2.34 @ ${outside()}`]);
      expect(flat(result.stdout)).toContain("Running: npm i -g @sous-io/sous@0.2.34");
      expect(flat(result.stdout)).toContain(`Registry : ${registry}@sous-io%2fsous`);
    },
    CLI_TIMEOUT
  );

  /**
   * With no terminal and no `--yes`, the run fails with the shared error
   * naming the question and `--yes`, and installs nothing.
   *
   * sous update (no terminal) -> exit 1, the error names --yes, no npm install
   */
  it(
    "should fail naming --yes when there is no terminal",
    async () => {
      installGlobal("0.2.30");

      const result = await runSous(outside(), "update");

      expect(result.status).toBe(1);
      const printed = flat(result.stdout + result.stderr);
      expect(printed).toContain('Error: Sous has to ask "Update the global install from 0.2.30 to 0.2.34?"');
      expect(printed).toContain("pass '--yes'");
      expect(takeCalls()).toEqual([]);
    },
    CLI_TIMEOUT
  );

  /**
   * In a project with its own copy, `update` is not handed to that copy: the
   * invoked copy updates the dependency in the project root, then runs the
   * NEW copy's bin with `build`, in the project, with the hand-off off.
   *
   * sous update --project --yes -> npm i -D -E ..., then project-copy build
   */
  it(
    "should update the project install and build with the new copy",
    async () => {
      const project = makeProject();

      const result = await runSous(project, "update", "--project", "--yes");

      expect(result.status).toBe(0);
      expect(takeCalls()).toEqual([
        `npm i -D -E @sous-io/sous@0.2.34 @ ${project}`,
        `project-copy build @ ${project} SOUS_NO_DELEGATE=1`,
      ]);
    },
    CLI_TIMEOUT
  );

  /**
   * A project config this copy rejects (here a top-level key the strict
   * schema does not know, as a config written for a newer sous would carry)
   * is one warning, not a stop: the update still runs, and the new copy still
   * builds the project, since it may be the copy that understands the config.
   *
   * sous update --project --yes (config rejected) -> warning, npm, project-copy build
   */
  it(
    "should warn about a config it cannot load and still update and build",
    async () => {
      const project = makeProject();
      const configPath = path.join(project, ".sous", "sous.config.json");
      fs.writeFileSync(configPath, '{ "version": 1, "futureSetting": true }', "utf8");

      const result = await runSous(project, "update", "--project", "--yes");

      expect(result.status).toBe(0);
      const printed = flat(result.stdout);
      expect(printed).toContain("WARNING:");
      expect(printed).toContain(
        `Sous could not load the project config at ${configPath}, so this command carries on without it.`
      );
      expect(printed).toContain("futureSetting");
      expect(printed).toContain(`Then builds : yes with the new copy, in ${project}`);
      expect(takeCalls()).toEqual([
        `npm i -D -E @sous-io/sous@0.2.34 @ ${project}`,
        `project-copy build @ ${project} SOUS_NO_DELEGATE=1`,
      ]);
    },
    CLI_TIMEOUT
  );

  /**
   * A rejected config in a subdirectory of the project is still where the
   * build runs, exactly as a config that loaded would be; the project root,
   * which has no config of its own here, is not.
   *
   * sous update --project --yes (in packages/app, its config rejected) -> build in packages/app
   */
  it(
    "should build where the rejected config is, inside the project",
    async () => {
      const project = makeProject();
      fs.rmSync(path.join(project, ".sous"), { recursive: true });
      const app = path.join(project, "packages", "app");
      fs.mkdirSync(path.join(app, ".sous"), { recursive: true });
      fs.writeFileSync(
        path.join(app, ".sous", "sous.config.json"),
        '{ "version": 1, "futureSetting": true }',
        "utf8"
      );

      const result = await runSous(app, "update", "--project", "--yes");

      expect(result.status).toBe(0);
      expect(flat(result.stdout)).toContain("Sous could not load the project config at");
      expect(takeCalls()).toEqual([
        `npm i -D -E @sous-io/sous@0.2.34 @ ${project}`,
        `project-copy build @ ${app} SOUS_NO_DELEGATE=1`,
      ]);
    },
    CLI_TIMEOUT
  );

  /**
   * `--no-build` updates the project install and runs no build.
   *
   * sous update --project --yes --no-build -> only npm runs
   */
  it(
    "should skip the build under --no-build",
    async () => {
      const project = makeProject();

      const result = await runSous(project, "update", "--project", "--yes", "--no-build");

      expect(result.status).toBe(0);
      expect(takeCalls()).toEqual([`npm i -D -E @sous-io/sous@0.2.34 @ ${project}`]);
    },
    CLI_TIMEOUT
  );

  /**
   * A dry run prints the plan and installs nothing.
   *
   * sous update --dry-run -> "Nothing was installed", no npm install
   */
  it(
    "should install nothing in a dry run",
    async () => {
      installGlobal("0.2.30");

      const result = await runSous(outside(), "update", "--dry-run");

      expect(result.status).toBe(0);
      expect(flat(result.stdout)).toContain("Command : npm i -g @sous-io/sous@0.2.34");
      expect(flat(result.stdout)).toContain("Nothing was installed.");
      expect(takeCalls()).toEqual([]);
    },
    CLI_TIMEOUT
  );

  /**
   * `--major` with `--version`, and `--global` with `--project`, are refused
   * before anything is read.
   *
   * sous update --major --version 1.0.0 -> exit 2, names both flags
   */
  it(
    "should refuse the flags that exclude each other",
    async () => {
      for (const [first, ...rest] of [
        ["--major", "--version", "1.0.0"],
        ["--global", "--project"],
      ]) {
        const result = await runSous(outside(), "update", first!, ...rest);
        expect(result.status).toBe(2);
        const printed = flat(result.stderr + result.stdout);
        expect(printed).toContain(first!);
        expect(printed).toContain(rest[0]!);
      }
      expect(takeCalls()).toEqual([]);
    },
    CLI_TIMEOUT
  );
});
