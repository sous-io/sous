import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTmpDir, type TmpDir } from "../utils/tmp.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const binPath = path.join(repoRoot, "bin", "run.js");

/** Per-test timeout: each test boots the real CLI (tsx + oclif) in a subprocess. */
const CLI_TIMEOUT = 30_000;

/**
 * These tests exercise `xcv launch` end to end through the real CLI entry
 * point, using a tool whose command is a small Node script that dumps the argv
 * it received to a JSON file. That dump is exactly what a real agent tool
 * (claude, codex) would have received.
 */
describe("launch pass-through args", () => {
  let tmp: TmpDir;
  let dumpFile: string;
  let configPath: string;

  /** Runs `xcv launch <argv...>` and returns the argv the tool received. */
  function launch(...argv: string[]): { toolArgv: string[] | null; status: number | null; output: string } {
    fs.rmSync(dumpFile, { force: true });
    const result = spawnSync(process.execPath, [binPath, "launch", ...argv], {
      cwd: tmp.path,
      encoding: "utf8",
      env: { ...process.env, DUMP_FILE: dumpFile },
    });
    const toolArgv = fs.existsSync(dumpFile)
      ? (JSON.parse(fs.readFileSync(dumpFile, "utf8")) as string[])
      : null;
    return { toolArgv, status: result.status, output: `${result.stdout}\n${result.stderr}` };
  }

  beforeAll(() => {
    tmp = makeTmpDir("sous-launch-");
    dumpFile = path.join(tmp.path, "dump.json");

    // The "tool": writes its argv (minus node + script path) to DUMP_FILE.
    const dumpScript = path.join(tmp.path, "dump-args.js");
    fs.writeFileSync(
      dumpScript,
      'require("fs").writeFileSync(process.env.DUMP_FILE, JSON.stringify(process.argv.slice(2)));\n'
    );

    const promptFile = path.join(tmp.path, "prompt.md");
    fs.writeFileSync(promptFile, "PROMPT-CONTENT");

    fs.mkdirSync(path.join(tmp.path, ".sous"));
    configPath = path.join(tmp.path, ".sous", "sous.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        projects: {
          demo: {
            name: "Demo",
            _vars: { projectRoot: "${sousDir}/.." },
            tools: {
              dump: { command: process.execPath, args: [dumpScript, "--defined-arg"] },
              dumpWithPrompt: {
                command: process.execPath,
                args: [dumpScript, "--defined-arg"],
                promptFile,
              },
            },
          },
        },
      })
    );
  });

  afterAll(() => {
    tmp.cleanup();
  });

  /**
   * Flags that launch does not define are forwarded to the tool, after the
   * config-defined tool args, preserving their order (so `--model opus` style
   * flag/value pairs survive). sous's own flags (--no-build here) are consumed
   * and never forwarded.
   *
   * xcv launch dump --no-build --resume --model opus
   *   → tool receives ["--defined-arg", "--resume", "--model", "opus"]
   */
  it(
    "should forward unknown flags to the tool after the config-defined args",
    () => {
      const { toolArgv, status } = launch("dump", "--no-build", "--resume", "--model", "opus");
      expect(status).toBe(0);
      expect(toolArgv).toEqual(["--defined-arg", "--resume", "--model", "opus"]);
    },
    CLI_TIMEOUT
  );

  /**
   * The `--flag=value` form is forwarded as a single token, exactly as typed.
   *
   * xcv launch dump --no-build --model=opus
   *   → tool receives ["--defined-arg", "--model=opus"]
   */
  it(
    "should forward --flag=value forms as a single token",
    () => {
      const { toolArgv, status } = launch("dump", "--no-build", "--model=opus");
      expect(status).toBe(0);
      expect(toolArgv).toEqual(["--defined-arg", "--model=opus"]);
    },
    CLI_TIMEOUT
  );

  /**
   * Everything after a bare `--` is forwarded verbatim, even tokens that would
   * otherwise parse as sous flags: claude's `-c` (--continue) and `-p` (print)
   * collide with sous's --config/--project shorthands, and `--` is the escape
   * hatch. sous must still resolve its own config normally (here via discovery
   * from cwd plus the single-project default).
   *
   * xcv launch dump --no-build -- -c -p hello
   *   → tool receives ["--defined-arg", "-c", "-p", "hello"]
   */
  it(
    "should forward everything after -- verbatim, including sous-colliding flags",
    () => {
      const { toolArgv, status } = launch("dump", "--no-build", "--", "-c", "-p", "hello");
      expect(status).toBe(0);
      expect(toolArgv).toEqual(["--defined-arg", "-c", "-p", "hello"]);
    },
    CLI_TIMEOUT
  );

  /**
   * sous flags before `--` keep working while the tail passes through: -c reads
   * the config, and pass-through collected before and after `--` is combined in
   * order.
   *
   * xcv launch dump --no-build -c <config> --resume -- -c
   *   → tool receives ["--defined-arg", "--resume", "-c"]
   */
  it(
    "should honor sous flags before -- and forward the tail",
    () => {
      const { toolArgv, status } = launch("dump", "--no-build", "-c", configPath, "--resume", "--", "-c");
      expect(status).toBe(0);
      expect(toolArgv).toEqual(["--defined-arg", "--resume", "-c"]);
    },
    CLI_TIMEOUT
  );

  /**
   * The promptFile content stays the LAST argument, after pass-through args, so
   * tools that treat a trailing positional as the prompt keep working.
   *
   * xcv launch dumpWithPrompt --no-build --resume
   *   → tool receives ["--defined-arg", "--resume", "PROMPT-CONTENT"]
   */
  it(
    "should append promptFile content after the pass-through args",
    () => {
      const { toolArgv, status } = launch("dumpWithPrompt", "--no-build", "--resume");
      expect(status).toBe(0);
      expect(toolArgv).toEqual(["--defined-arg", "--resume", "PROMPT-CONTENT"]);
    },
    CLI_TIMEOUT
  );

  /**
   * With no extra arguments the tool receives only the config-defined args —
   * the pre-pass-through behavior is unchanged.
   *
   * xcv launch dump --no-build
   *   → tool receives ["--defined-arg"]
   */
  it(
    "should pass only the config-defined args when no extra args are given",
    () => {
      const { toolArgv, status } = launch("dump", "--no-build");
      expect(status).toBe(0);
      expect(toolArgv).toEqual(["--defined-arg"]);
    },
    CLI_TIMEOUT
  );
});
