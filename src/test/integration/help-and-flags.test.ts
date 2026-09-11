/**
 * The two conveniences a command line is judged on before anything else: being
 * able to read the help however you ask for it, and being able to say yes to a
 * confirmation however you spell it.
 *
 * Everything here runs the real published bin in a subprocess, whose stdin and
 * stdout are pipes rather than terminals. That is exactly the condition under
 * which sous refuses to ask a question, so a run that succeeds is proof the
 * confirmation was answered by the flag and never by a prompt.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";
import { buildFixtureRepo } from "../utils/fixture-repo.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");

/** Per-test budget: each of these boots the real CLI (tsx + oclif) at least once. */
const CLI_TIMEOUT = 90_000;

type RunResult = { stdout: string; stderr: string; status: number | null };

let tmp: TmpDir;
let projectRoot: string;
let sousDir: string;
let sousHome: string;
let fixtureRepo: string;

/**
 * Runs `sous <args...>` through the real bin, from `cwd`, with the machine-wide
 * store pointed at this test's temporary directory. Ambient `SOUS_*` project
 * variables are stripped so the child discovers its config by walking up.
 */
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

/** Writes a file, creating its parent directories. */
function write(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

/** Strips ANSI escape codes, so output comparisons ignore color. */
const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("help in every form, and one confirmation flag", () => {
  beforeAll(async () => {
    tmp = makeTmpDir("sous-help-flags-");
    sousHome = path.join(tmp.path, "sous-home");
    projectRoot = path.join(tmp.path, "project");
    sousDir = path.join(projectRoot, ".sous");
    fixtureRepo = path.join(tmp.path, "fixtures");

    // Three interchangeable recipes, one per spelling of the confirmation flag,
    // so each subscription is a fresh decision rather than a no-op repeat.
    await buildFixtureRepo(fixtureRepo, "fixtures", [
      {
        namespace: "workflow",
        name: "first",
        version: "1.0.0",
        description: "A recipe subscribed to with --yes",
        files: { "skills/first/SKILL.md": "# First\n" },
      },
      {
        namespace: "workflow",
        name: "second",
        version: "1.0.0",
        description: "A recipe subscribed to with --force",
        files: { "skills/second/SKILL.md": "# Second\n" },
      },
      {
        namespace: "workflow",
        name: "third",
        version: "1.0.0",
        description: "A recipe subscribed to with --trust",
        files: { "skills/third/SKILL.md": "# Third\n" },
      },
    ]);

    write(
      path.join(sousDir, "sous.config.js"),
      [
        "export const config = {",
        '  name: "Help And Flags Test Project",',
        '  _vars: { projectRoot: "${sousDir}/.." },',
        // The official repository is switched off, so the whole file runs
        // against the local fixture repository and never reaches the network.
        '  repos: { "sous-recipes": { enabled: false } },',
        "  compilation: {",
        "    targets: [",
        "      {",
        '        entryPoint: "${sousDir}/prompts/AGENTS.md",',
        '        outputs: [{ destinationFile: "${projectRoot}/AGENTS.md" }],',
        "      },",
        "    ],",
        "  },",
        "};",
        "",
      ].join("\n")
    );
    write(path.join(sousDir, "prompts", "AGENTS.md"), "# The project\n");
  }, CLI_TIMEOUT);

  afterAll(() => {
    tmp.cleanup();
  });

  // --- Help ------------------------------------------------------------------------------------

  /**
   * `sous help <topic> <command>` must print exactly what `--help` prints; they
   * are the same screen drawn by the same help class, not two renderings that
   * could drift apart.
   *
   * sous help repo add   ===   sous repo add --help
   */
  it(
    "should print the same screen for 'help repo add' as for 'repo add --help'",
    () => {
      const viaHelpCommand = sous(projectRoot, "help", "repo", "add");
      const viaHelpFlag = sous(projectRoot, "repo", "add", "--help");

      expect(viaHelpCommand.status).toBe(0);
      expect(viaHelpFlag.status).toBe(0);
      expect(strip(viaHelpCommand.stdout)).toBe(strip(viaHelpFlag.stdout));
      expect(strip(viaHelpCommand.stdout)).toContain("sous repo add URL");
    },
    CLI_TIMEOUT
  );

  /**
   * `-h` is registered as an additional help flag, so it works everywhere
   * `--help` does, on a nested command as readily as on the root.
   *
   * sous repo add -h   // -> the repo add help screen
   */
  it(
    "should print help for 'repo add -h'",
    () => {
      const result = sous(projectRoot, "repo", "add", "-h");

      expect(result.status).toBe(0);
      expect(strip(result.stdout)).toContain("USAGE");
      expect(strip(result.stdout)).toContain("sous repo add URL");
    },
    CLI_TIMEOUT
  );

  /**
   * `sous help` on its own prints the root help, which lists the topics and the
   * commands, and `sous help <topic>` prints that topic's command list.
   *
   * sous help        // -> TOPICS and COMMANDS
   * sous help repo   // -> "$ sous repo COMMAND" and the repo topic's commands
   */
  it(
    "should print root help for 'help' and topic help for 'help repo'",
    () => {
      const root = sous(projectRoot, "help");
      expect(root.status).toBe(0);
      expect(strip(root.stdout)).toContain("TOPICS");
      expect(strip(root.stdout)).toContain("COMMANDS");

      const topic = sous(projectRoot, "help", "repo");
      expect(topic.status).toBe(0);
      expect(strip(topic.stdout)).toContain("sous repo COMMAND");
      expect(strip(topic.stdout)).toContain("repo add");
      expect(strip(topic.stdout)).toContain("repo link");
    },
    CLI_TIMEOUT
  );

  /**
   * The help screen names a flag once, with its other spellings in a compact
   * suffix. `--force` and `--trust` must therefore not appear as flag entries
   * of their own.
   *
   * sous help subscription add   // -> "-y, --yes ... (also -f, --force, --trust)"
   */
  it(
    "should list the confirmation flag once, naming its aliases compactly",
    () => {
      const result = sous(projectRoot, "help", "subscription", "add");
      const output = strip(result.stdout);

      expect(result.status).toBe(0);
      expect(output).toContain("-y, --yes");
      expect(output).toContain("(also -f, --force, --trust)");
      // No alias gets a line of its own in the flag list.
      expect(output).not.toMatch(/^\s+--force\s{2,}/m);
      expect(output).not.toMatch(/^\s+--trust\s{2,}/m);
    },
    CLI_TIMEOUT
  );

  // --- One confirmation flag -------------------------------------------------------------------

  /**
   * With no terminal and no confirmation flag, subscribing must refuse rather
   * than guess, and say which flag would have answered it. This is the control
   * the three spellings below are measured against.
   *
   * sous subscribe workflow/first   // -> non-zero, names --yes
   */
  it(
    "should refuse to subscribe with no terminal and no confirmation flag",
    () => {
      expect(sous(projectRoot, "repo", "add", fixtureRepo, "--trust").status).toBe(0);

      const result = sous(projectRoot, "subscribe", "workflow/first");
      const output = strip(result.stdout + result.stderr);

      expect(result.status).not.toBe(0);
      expect(output).toContain("--yes");
    },
    CLI_TIMEOUT
  );

  /**
   * Every spelling of the confirmation flag skips the same question, because
   * they are one flag: `-y`, `--force` and `--trust` all subscribe without
   * being asked.
   *
   * sous subscribe workflow/first  -y
   * sous subscribe workflow/second --force
   * sous subscribe workflow/third  --trust
   */
  it(
    "should subscribe with -y, with --force and with --trust alike",
    () => {
      const attempts: Array<[string, string]> = [
        ["workflow/first", "-y"],
        ["workflow/second", "--force"],
        ["workflow/third", "--trust"],
      ];

      for (const [ref, spelling] of attempts) {
        const result = sous(projectRoot, "subscribe", ref, spelling);
        const output = strip(result.stdout + result.stderr);
        expect(result.status, `${spelling} on ${ref}: ${output}`).toBe(0);
        expect(output).toContain(ref);
      }
    },
    CLI_TIMEOUT
  );

  /**
   * `clear` keeps `--force` as its own spelling and gains `-y` as an alias of
   * it, so the two runs do exactly the same thing.
   *
   * sous build && sous clear -y   ===   sous build && sous clear --force
   */
  it(
    "should treat 'clear -y' and 'clear --force' as the same command",
    () => {
      expect(sous(projectRoot, "build").status).toBe(0);
      const viaYes = sous(projectRoot, "clear", "-y");

      expect(sous(projectRoot, "build").status).toBe(0);
      const viaForce = sous(projectRoot, "clear", "--force");

      expect(viaYes.status).toBe(0);
      expect(viaForce.status).toBe(0);
      expect(strip(viaYes.stdout)).toBe(strip(viaForce.stdout));
      expect(fs.existsSync(path.join(projectRoot, "AGENTS.md"))).toBe(false);
    },
    CLI_TIMEOUT
  );
});
