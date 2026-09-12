/**
 * One way for every sous command to report a failure.
 *
 * A person who forgets an argument, misspells a flag, or runs sous where there
 * is no config has made an ordinary mistake, and what they need back is the
 * sentence describing it (plus, when the mistake is a usage one, the command's
 * own help). A stack trace pointing into oclif's parser tells them nothing, so
 * no expected failure prints one. A trace is still one environment variable
 * away: set `SOUS_DEBUG` and every reported error prints its stack to stderr.
 *
 * The same reporting is used by every command. `BaseCommand.catch` calls it for
 * the commands that discover a config; the repository authoring commands
 * (`repo init`, `repo release`, `repo submit`) extend oclif's `Command`
 * directly and call it from their own `catch`, so all of sous fails the same
 * way.
 */

import { Errors, type Command } from "@oclif/core";
import { isConfigError } from "../lib/errors.js";
import { wantsHelp } from "../lib/interactive.js";
import { displayErrorBlock, log } from "./formatting.js";
import { printCommandHelpToStderr } from "./command-help.js";

/** The environment variable that turns stack traces back on. */
export const DEBUG_ENV_VAR = "SOUS_DEBUG";

/**
 * Values of `SOUS_DEBUG` that mean "not set". Everything else counts as set,
 * because people spell it `1`, `true` and `yes` in roughly equal measure. The
 * same list gates the `CI` variable in `lib/interactive.ts`.
 */
const FALSY_DEBUG_VALUES = new Set(["", "0", "false", "no", "off"]);

/** The line oclif appends to a parse error, replaced by the help screen itself. */
const OCLIF_HELP_HINT = "See more help with --help";

/** The sentence an unexpected failure ends with, since sous cannot explain it. */
const UNEXPECTED_REMEDY = `Sous did not expect this error; set '${DEBUG_ENV_VAR}=1' and run the command again for the full stack trace.`;

/** Where the report is written, and what it reads to decide about traces. */
export type ErrorReportOptions = {
  /**
   * Line sink for the error text. Defaults to stdout via `log`; commands whose
   * stdout must stay machine-readable pass a stderr writer.
   */
  write?: (line: string) => void;
  /** The environment, read for `SOUS_DEBUG`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
};

/**
 * True when this run was asked for stack traces, either by `SOUS_DEBUG` or by
 * oclif's own debug setting (which `--debug`-style bootstrapping turns on).
 *
 * @param env - The environment to read. Defaults to the real one.
 */
export function stackTracesRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const oclifDebug = (globalThis as { oclif?: { debug?: boolean } }).oclif?.debug;
  if (oclifDebug === true) return true;

  const raw = env[DEBUG_ENV_VAR];
  if (raw === undefined) return false;
  return !FALSY_DEBUG_VALUES.has(raw.trim().toLowerCase());
}

/**
 * True when the "error" is only a request to end the process, which every
 * `this.exit(code)` raises. It carries no message and must reach oclif
 * untouched, or a clean exit would be reported as a failure.
 *
 * @param error - The thrown value.
 */
export function isExitSignal(error: unknown): boolean {
  if (error instanceof Errors.ExitError) return true;
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "EEXIT";
}

/**
 * True when the caller got the command line wrong (a missing argument, an
 * unknown flag, a value outside a flag's options) or asked a question sous
 * could not ask. Both are answered by showing the command's own help, so both
 * are treated the same way.
 *
 * oclif's parse errors all carry a `parse` property; nothing else oclif throws
 * does, which is what separates a usage mistake from a reported failure.
 *
 * @param error - The thrown value.
 */
export function isUsageError(error: unknown): boolean {
  if (wantsHelp(error)) return true;
  return error instanceof Errors.CLIError && "parse" in error;
}

/**
 * Reports one command failure in sous's own voice: the message, the command's
 * help underneath it when the message alone is not enough, and a stack trace
 * only when one was asked for.
 *
 * @param command - The command that failed, whose help may be drawn.
 * @param error - The error it failed with.
 * @param options - Where to write, and the environment to read.
 * @returns The exit code the run should end with, or undefined when this error
 *   is not sous's to report and must fall through to oclif's own handling.
 */
export async function reportCommandError(
  command: Command,
  error: Error & { exitCode?: number; oclif?: { exit?: number | false } },
  options: ErrorReportOptions = {}
): Promise<number | undefined> {
  // A clean exit, and a command rendering its own JSON error, both belong to
  // oclif; neither is a failure for sous to describe.
  if (isExitSignal(error)) return undefined;
  if (jsonRequested(command)) return undefined;

  const write = options.write ?? log;
  const showHelp = isUsageError(error);
  const expected = showHelp || isConfigError(error) || error instanceof Errors.CLIError;

  const body = [messageOf(error, showHelp)];
  if (!expected) body.push("", UNEXPECTED_REMEDY);

  displayErrorBlock(body.join("\n"), write);

  if (stackTracesRequested(options.env ?? process.env)) writeStackToStderr(error);
  if (showHelp) await printCommandHelpToStderr(command);

  return exitCodeOf(error);
}

/**
 * The message to print, with oclif's "See more help with --help" line removed
 * when the help itself is about to be printed underneath it.
 *
 * @param error - The error being reported.
 * @param showHelp - Whether the command's help follows the message.
 */
function messageOf(error: Error, showHelp: boolean): string {
  const message = error.message?.trim() === "" ? String(error) : error.message;
  if (!showHelp) return message;
  return message
    .split("\n")
    .filter((line) => line.trim() !== OCLIF_HELP_HINT)
    .join("\n")
    .trimEnd();
}

/**
 * Writes an error's stack to stderr, verbatim and uncolored. It is diagnostic
 * output for whoever set `SOUS_DEBUG`, never part of what the command prints.
 *
 * @param error - The error whose stack to write.
 */
function writeStackToStderr(error: Error): void {
  const stack = error.stack ?? "";
  if (stack.trim() === "") return;
  process.stderr.write(`${stack}\n`);
}

/**
 * The exit code a failure ends with: the one oclif assigned when it assigned
 * one (a parse error exits 2), and 1 for everything else.
 *
 * @param error - The error being reported.
 */
function exitCodeOf(error: Error & { exitCode?: number; oclif?: { exit?: number | false } }): number {
  const fromOclif = error.oclif?.exit;
  if (typeof fromOclif === "number" && Number.isInteger(fromOclif)) return fromOclif;
  if (typeof error.exitCode === "number" && Number.isInteger(error.exitCode)) return error.exitCode;
  return 1;
}

/**
 * True when the command is rendering machine-readable JSON, in which case oclif
 * owns the error output and sous must not print a human error over it.
 *
 * @param command - The command that failed.
 */
function jsonRequested(command: Command): boolean {
  const enabled = (command as { jsonEnabled?: () => boolean }).jsonEnabled;
  if (typeof enabled !== "function") return false;
  try {
    return enabled.call(command) === true;
  } catch {
    return false;
  }
}
