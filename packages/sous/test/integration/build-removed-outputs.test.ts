/**
 * What a build prints when it removes outputs no target produces any more (gh-204, gh-229): the
 * removed files are listed under a heading, before the build's closing "Done.".
 *
 * The project compiles one local template, so nothing reaches the network; `SOUS_HOME` is inside
 * the test's temporary directory.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { binPath } from "../utils/sous-bin.js";

/** Per-test budget: the test boots the real CLI twice. */
const CLI_TIMEOUT = 120_000;

let tmp: TmpDir;
let projectRoot: string;

/** Runs `sous <args...>` through the real bin and returns everything it printed. */
function sousOk(...args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, SOUS_HOME: path.join(tmp.path, "sous-home") };
  delete env.SOUS_CONFIG;
  delete env.SOUS_DIR;
  delete env.SOUS_CONFD;
  const result = spawnSync(process.execPath, [binPath, ...args], { cwd: projectRoot, encoding: "utf8", env });
  const output = `${result.stdout}${result.stderr}`;
  expect(result.status, output).toBe(0);
  return output;
}

/** Writes the project config, compiling its one template to each file named. */
function writeConfig(destinations: string[]): void {
  const outputs = destinations.map((dest) => `{ destinationFile: "\${projectRoot}/${dest}" }`).join(", ");
  fs.writeFileSync(
    path.join(projectRoot, ".sous", "sous.config.js"),
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

beforeEach(() => {
  tmp = makeTmpDir("sous-removed-outputs-");
  projectRoot = path.join(tmp.path, "project");
  fs.mkdirSync(path.join(projectRoot, ".sous", "prompts"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, ".sous", "prompts", "AGENTS.md"), "# The project\n");
});

afterEach(() => {
  tmp.cleanup();
});

describe("a build that removes outputs", () => {
  /**
   * The removed files are listed under "Removed outputs", and "Done." comes after them.
   *
   * sous build   # writes AGENTS.md and OLD.md
   * # the config drops OLD.md
   * sous build
   * // -> Removed outputs
   * //      − <project>/OLD.md (removed)
   * //    Done.
   */
  it(
    "should list the removed outputs under a heading before Done.",
    () => {
      writeConfig(["AGENTS.md", "OLD.md"]);
      sousOk("build");
      writeConfig(["AGENTS.md"]);

      const lines = sousOk("build").split("\n");
      const heading = lines.findIndex((line) => line.includes("Removed outputs"));
      const removed = lines.findIndex((line) => line.includes(path.join(projectRoot, "OLD.md")) && line.includes("removed"));
      const done = lines.findIndex((line) => line.trim() === "Done.");

      expect(removed, lines.join("\n")).toBeGreaterThan(-1);
      expect(heading, lines.join("\n")).toBeGreaterThan(-1);
      expect(heading, lines.join("\n")).toBeLessThan(removed);
      expect(done, lines.join("\n")).toBeGreaterThan(removed);
      expect(fs.existsSync(path.join(projectRoot, "OLD.md"))).toBe(false);
    },
    CLI_TIMEOUT
  );
});
