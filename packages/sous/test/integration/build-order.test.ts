/**
 * The order inside one build, end to end, through the real CLI: a recipe's `check` handler runs
 * before anything is written, the editor applies the project's declared edit after the compiler,
 * and the flags let a build past a failed check.
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

/** Per-test budget: each one boots the real CLI several times. */
const CLI_TIMEOUT = 120_000;

type RunResult = { status: number | null; output: string };

let tmp: TmpDir;
let sousHome: string;
let offlineHook: string;
let projectRoot: string;

/** The settings file the project's declared edit changes, as it was before Sous touched it. */
const SETTINGS_BEFORE = '{\n  // the project\'s own comment\n  "keep": 1\n}\n';

/** The project's config: the fixture repository's recipe, and, when asked, one declared edit with an assertion. */
function writeConfig(withEdit: boolean): void {
  const edit = withEdit
    ? [
        '  "editor": {',
        '    "edits": [',
        "      {",
        '        "file": "settings.jsonc",',
        '        "set": { "path": "mode", "value": "strict" },',
        '        "assert": { "path": "mode", "equals": "strict", "message": "The mode must be strict." }',
        "      }",
        "    ]",
        "  },",
      ]
    : [];

  writeFixtureFile(
    path.join(projectRoot, ".sous", "sous.config.jsonc"),
    ["{", '  "name": "Build Order",', ...edit, '  "repos": { "sous-recipes": { "enabled": false } }', "}", ""].join("\n")
  );
}

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
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const settings = () => fs.readFileSync(path.join(projectRoot, "settings.jsonc"), "utf8");
const blocker = () => path.join(projectRoot, "block-the-build");

beforeAll(async () => {
  tmp = makeTmpDir("sous-build-order-");
  sousHome = path.join(tmp.path, "sous-home");
  projectRoot = path.join(tmp.path, "project");
  const repo = path.join(tmp.path, "fixtures");

  offlineHook = writeFixtureFile(
    path.join(tmp.path, "offline.mjs"),
    ["globalThis.fetch = async (url) => {", "  throw new Error(`offline: this test machine cannot reach ${url}`);", "};", ""].join("\n")
  );

  // A recipe whose check handler reports an error while the project holds a file named
  // block-the-build, and a warning saying it ran otherwise.
  await buildFixtureRepo(repo, "fixtures", [
    {
      namespace: "checks",
      name: "ready",
      version: "1.0.0",
      contents: [],
      handlers: { check: [{ file: "handlers/ready.js", handler: "checkReady" }] },
      files: {
        "handlers/ready.js": [
          "export async function checkReady(sous) {",
          '  if (await sous.utils.file.exists("block-the-build")) {',
          '    sous.report.error("The file block-the-build says not to build.");',
          "  } else {",
          '    sous.report.warn("The ready check ran.");',
          "  }",
          "}",
          "",
        ].join("\n"),
      },
    },
  ]);

  writeConfig(true);
  writeFixtureFile(path.join(projectRoot, "settings.jsonc"), SETTINGS_BEFORE);

  for (const args of [
    ["repo", "add", repo, "--name", "fixtures", "--trust"],
    ["subscription", "add", "checks/ready", "--yes", "--no-build"],
  ]) {
    const result = sous(...args);
    expect(result.status, result.output).toBe(0);
  }
}, CLI_TIMEOUT);

afterAll(() => {
  tmp.cleanup();
});

describe("the order inside one build", () => {
  /**
   * The recipe's check runs, the declared edit is written (its assertion holds), and a second
   * build changes nothing.
   *
   * sous build   // -> "The ready check ran."; settings.jsonc gains "mode": "strict", keeps its comment
   * sous build   // -> settings.jsonc and the edit history byte for byte the same
   */
  it(
    "should run the check, write the edit, and change nothing on a second build",
    () => {
      const first = sous("build");
      expect(first.status, first.output).toBe(0);
      expect(first.output).toContain("The ready check ran.");

      const written = settings();
      expect(written).toContain("// the project's own comment");
      expect(JSON.parse(written.replace(/\/\/.*$/gm, ""))).toEqual({ keep: 1, mode: "strict" });

      const history = fs.readFileSync(path.join(projectRoot, ".sous", "sous.edits.json"), "utf8");
      const second = sous("build");
      expect(second.status, second.output).toBe(0);
      expect(settings()).toBe(written);
      expect(fs.readFileSync(path.join(projectRoot, ".sous", "sous.edits.json"), "utf8")).toBe(history);
    },
    CLI_TIMEOUT
  );

  /**
   * Removing the entry from the config undoes the edit: the file is back to its bytes before Sous.
   *
   * editor.edits removed; sous build   // -> settings.jsonc as it was
   */
  it(
    "should undo the edit when the entry is removed",
    () => {
      writeConfig(false);
      const result = sous("build");
      expect(result.status, result.output).toBe(0);
      expect(settings()).toBe(SETTINGS_BEFORE);
    },
    CLI_TIMEOUT
  );

  /**
   * A failed check stops the build before anything is written: the declared edit is not made,
   * the exit code is 1, and the message names the flag that builds anyway.
   *
   * block-the-build exists; sous build   // -> exit 1, settings.jsonc untouched
   */
  it(
    "should stop before writing anything when the check fails",
    () => {
      writeConfig(true);
      fs.writeFileSync(blocker(), "");

      const result = sous("build");
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain("The file block-the-build says not to build.");
      expect(result.output).toContain("--ignore-failed-checks");
      expect(settings()).toBe(SETTINGS_BEFORE);
    },
    CLI_TIMEOUT
  );

  /**
   * `--ignore-failed-checks` lets the build through: the error is printed as an ignored warning,
   * the edit is written, and the build ends as successful.
   *
   * sous build --ignore-failed-checks   // -> exit 0, "mode": "strict" written
   */
  it(
    "should build past the failed check with --ignore-failed-checks",
    () => {
      const result = sous("build", "--ignore-failed-checks");
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain("ignored");
      expect(JSON.parse(settings().replace(/\/\/.*$/gm, ""))).toEqual({ keep: 1, mode: "strict" });

      fs.rmSync(blocker());
    },
    CLI_TIMEOUT
  );
});
