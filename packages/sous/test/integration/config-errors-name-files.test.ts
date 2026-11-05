/**
 * A config value that fails its schema is reported with the file that set it, not the name of
 * the internal layer that read the file (gh-229): ".sous/sous.config.js", not "config-files.main".
 *
 * Everything here runs the real bin against a throwaway project with the official repository
 * switched off, so nothing reaches the network.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";

import { binPath } from "../utils/sous-bin.js";

/** Per-test budget: each one boots the real CLI. */
const CLI_TIMEOUT = 90_000;

let tmp: TmpDir;
let projectRoot: string;

/** Strips ANSI color codes and joins wrapped lines, so a message reads as one sentence. */
const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s+/g, " ");

/** Writes a file, creating its parent directories. */
function write(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

/** Runs `sous <args...>` from the project, with the machine-wide store inside the temp tree. */
function sous(...args: string[]): { output: string; status: number | null } {
  const env: NodeJS.ProcessEnv = { ...process.env, SOUS_HOME: path.join(tmp.path, "sous-home") };
  delete env.SOUS_CONFIG;
  delete env.SOUS_DIR;
  delete env.SOUS_CONFD;
  const result = spawnSync(process.execPath, [binPath, ...args], { cwd: projectRoot, encoding: "utf8", env });

  return { output: plain(`${result.stdout}${result.stderr}`), status: result.status };
}

beforeEach(() => {
  tmp = makeTmpDir("sous-config-errors-");
  projectRoot = path.join(tmp.path, "project");
});

afterEach(() => {
  tmp.cleanup();
});

describe("config validation errors name the file that set the value", () => {
  /**
   * A wrong value in the main config file names that file, from the project root.
   *
   * recipes.skills.outputs: Expected array, got string "skills". (set by .sous/sous.config.js)
   */
  it(
    "should name the main config file",
    () => {
      write(
        path.join(projectRoot, ".sous", "sous.config.js"),
        'export const config = { repos: { "sous-recipes": { enabled: false } }, recipes: { skills: { outputs: "skills" } } };\n'
      );

      const result = sous("config", "show");

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("recipes.skills.outputs:");
      expect(result.output).toContain(`(set by ${path.join(".sous", "sous.config.js")})`);
      expect(result.output).not.toContain("config-files.main");
    },
    CLI_TIMEOUT
  );

  /**
   * A wrong value in a conf.d file names that file.
   *
   * recipes.skills.outputs: Expected array, got string "skills". (set by .sous/conf.d/610-mine.json)
   */
  it(
    "should name the conf.d file",
    () => {
      write(path.join(projectRoot, ".sous", "sous.config.js"), 'export const config = { repos: { "sous-recipes": { enabled: false } } };\n');
      write(path.join(projectRoot, ".sous", "conf.d", "610-mine.json"), '{ "recipes": { "skills": { "outputs": "skills" } } }\n');

      const result = sous("config", "show");

      expect(result.status).not.toBe(0);
      expect(result.output).toContain("recipes.skills.outputs:");
      expect(result.output).toContain(`(set by ${path.join(".sous", "conf.d", "610-mine.json")})`);
      expect(result.output).not.toContain("confd/610-mine.json");
    },
    CLI_TIMEOUT
  );
});
