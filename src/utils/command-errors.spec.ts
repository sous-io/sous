/**
 * The one place a sous command failure is turned into words.
 *
 * Everything here is about what a person sees: a sentence rather than a stack,
 * the help screen when the command line itself was the problem, a pointer at
 * SOUS_DEBUG when sous cannot explain the failure, and oclif's own exit code
 * kept intact.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Errors, type Command } from "@oclif/core";
import { ConfigError } from "../lib/errors.js";
import { NonInteractiveError } from "../lib/interactive.js";
import {
  DEBUG_ENV_VAR,
  isExitSignal,
  isUsageError,
  reportCommandError,
  stackTracesRequested,
} from "./command-errors.js";

/** Strips ANSI escape codes, so assertions ignore color. */
const strip = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * A stand-in for a real command. Only two things are asked of it: whether it is
 * rendering JSON, and (for a usage error) its help, which cannot be drawn
 * without a real oclif config and is swallowed when it fails.
 */
function fakeCommand(json = false): Command {
  return { id: "repo add", jsonEnabled: () => json } as unknown as Command;
}

/** Collects the lines one report wrote, with color stripped. */
function reportOf(
  error: Error,
  env: NodeJS.ProcessEnv = {},
  command: Command = fakeCommand()
): Promise<{ lines: string[]; exitCode: number | undefined }> {
  const lines: string[] = [];
  return reportCommandError(command, error, { write: (line) => lines.push(strip(line)), env }).then(
    (exitCode) => ({ lines, exitCode })
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stackTracesRequested()", () => {
  /**
   * An unset SOUS_DEBUG, and every spelling of "off", mean no traces; anything
   * else means the caller wants them.
   *
   * stackTracesRequested({ SOUS_DEBUG: "0" });  // -> false
   * stackTracesRequested({ SOUS_DEBUG: "1" });  // -> true
   */
  it("should treat only the falsy spellings as unset", () => {
    expect(stackTracesRequested({})).toBe(false);
    for (const value of ["", "0", "false", "no", "off", " OFF "]) {
      expect(stackTracesRequested({ [DEBUG_ENV_VAR]: value })).toBe(false);
    }
    for (const value of ["1", "true", "yes", "on", "anything"]) {
      expect(stackTracesRequested({ [DEBUG_ENV_VAR]: value })).toBe(true);
    }
  });
});

describe("isExitSignal()", () => {
  /**
   * `this.exit(code)` raises an ExitError, which is a request to end the run
   * rather than a failure to describe.
   *
   * isExitSignal(new Errors.ExitError(0));  // -> true
   * isExitSignal(new TypeError("boom"));    // -> false
   */
  it("should recognize an exit request and nothing else", () => {
    expect(isExitSignal(new Errors.ExitError(0))).toBe(true);
    expect(isExitSignal(Object.assign(new Error("done"), { code: "EEXIT" }))).toBe(true);
    expect(isExitSignal(new TypeError("boom"))).toBe(false);
    expect(isExitSignal(new ConfigError("no config"))).toBe(false);
  });
});

describe("isUsageError()", () => {
  /**
   * A mistyped command line and a question sous could not ask are both answered
   * by the command's help; an ordinary config mistake is not.
   *
   * isUsageError(new NonInteractiveError("..."));  // -> true
   * isUsageError(new ConfigError("..."));          // -> false
   */
  it("should count a blocked prompt and an oclif parse error, but not a config error", () => {
    expect(isUsageError(new NonInteractiveError("cannot ask"))).toBe(true);
    expect(isUsageError(new ConfigError("bad config"))).toBe(false);
    expect(isUsageError(new TypeError("boom"))).toBe(false);

    const parseError = Object.assign(new Errors.CLIError("Nonexistent flag: --nope"), {
      parse: {},
    });
    expect(isUsageError(parseError)).toBe(true);
  });
});

describe("reportCommandError()", () => {
  /**
   * A config mistake prints as the sentence describing it, prefixed once, with
   * no stack frames anywhere, and ends the run with code 1.
   *
   * reportCommandError(command, new ConfigError("No sous config found."));
   * // -> "Error: No sous config found." and exit code 1
   */
  it("should print a config error as a plain message with no stack", async () => {
    const { lines, exitCode } = await reportOf(new ConfigError("No sous config found."));

    expect(lines.join("\n")).toContain("Error: No sous config found.");
    expect(lines.join("\n")).not.toContain("    at ");
    expect(exitCode).toBe(1);
  });

  /**
   * An error sous did not expect still prints as a sentence, followed by the
   * one thing the caller can do about it.
   *
   * reportCommandError(command, new TypeError("x is not a function"));
   * // -> "Error: x is not a function" plus a line naming SOUS_DEBUG
   */
  it("should point an unexpected error at SOUS_DEBUG instead of printing a stack", async () => {
    const { lines, exitCode } = await reportOf(new TypeError("x is not a function"));
    const output = lines.join("\n");

    expect(output).toContain("Error: x is not a function");
    expect(output).toContain(`${DEBUG_ENV_VAR}=1`);
    expect(output).not.toContain("    at ");
    expect(exitCode).toBe(1);
  });

  /**
   * A usage error keeps oclif's exit code (2) and drops oclif's "See more help
   * with --help" line, because the help itself is printed underneath it.
   *
   * reportCommandError(command, requiredArgsError);  // -> exit code 2
   */
  it("should keep oclif's exit code and drop its help hint on a usage error", async () => {
    const parseError = Object.assign(
      new Errors.CLIError("Nonexistent flag: --nope\nSee more help with --help", { exit: 2 }),
      { parse: {} }
    );

    const { lines, exitCode } = await reportOf(parseError);
    const output = lines.join("\n");

    expect(output).toContain("Error: Nonexistent flag: --nope");
    expect(output).not.toContain("See more help with --help");
    expect(exitCode).toBe(2);
  });

  /**
   * With SOUS_DEBUG set, the stack goes to stderr, where it is diagnostic
   * output rather than part of what the command prints.
   *
   * SOUS_DEBUG=1 sous build   // -> the message, then the frames on stderr
   */
  it("should write the stack to stderr when SOUS_DEBUG asks for it", async () => {
    const written: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });

    const { lines } = await reportOf(new ConfigError("No sous config found."), {
      [DEBUG_ENV_VAR]: "1",
    });

    expect(lines.join("\n")).not.toContain("    at ");
    expect(written.join("")).toContain("    at ");
  });

  /**
   * An exit request and a command rendering JSON both belong to oclif: nothing
   * is printed and nothing is claimed.
   *
   * reportCommandError(command, new Errors.ExitError(0));  // -> undefined
   */
  it("should leave an exit request and a JSON command to oclif", async () => {
    const exiting = await reportOf(new Errors.ExitError(0));
    expect(exiting.lines).toEqual([]);
    expect(exiting.exitCode).toBeUndefined();

    const json = await reportOf(new ConfigError("No sous config found."), {}, fakeCommand(true));
    expect(json.lines).toEqual([]);
    expect(json.exitCode).toBeUndefined();
  });
});
