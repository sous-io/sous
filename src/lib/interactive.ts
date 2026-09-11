/**
 * The one rule for "may sous ask a question right now?".
 *
 * Every prompt in sous (the trust question, the subscribe confirmation, the
 * choice between candidate refs, a variable question) is gated by this single
 * predicate, so a run either can ask all of them or none of them. Three things
 * can take the terminal away:
 *
 *   - the global `--non-interactive` flag, which says so outright;
 *   - a truthy `CI` environment variable, which every continuous integration
 *     runner sets and which means no human is watching;
 *   - stdin or stdout not being a terminal, which is what piping or scripting
 *     a command looks like from in here.
 *
 * When a prompt cannot be shown, the run fails rather than guessing, and the
 * failure names both the question that could not be asked and the flag (or the
 * environment variables) that would have answered it ahead of time. Every
 * confirmation in sous is answered by one shared flag, `--yes` (also `-y`,
 * `--force`, and `--trust` on the commands that trust a repository), so a
 * remedy names that flag and lists its other spellings once. The command layer
 * prints the command's own help underneath that error, so the caller can see
 * every flag without going looking; `sous help <command>` prints the same
 * screen on demand.
 *
 * Every input is injectable, so a test can describe a terminal, a pipe or a CI
 * runner without touching the real process.
 */

import { ConfigError } from "./errors.js";

/** Everything the rule reads. Each field defaults to the real process. */
export type InteractiveInputs = {
  /** The command line, scanned for `--non-interactive`. Defaults to `process.argv`. */
  argv?: string[];
  /** The environment, read for `CI`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Whether stdin is a terminal. Defaults to the real stdin. */
  stdinIsTTY?: boolean;
  /** Whether stdout is a terminal. Defaults to the real stdout. */
  stdoutIsTTY?: boolean;
};

/** The global flag that turns every prompt into an error. */
export const NON_INTERACTIVE_FLAG = "--non-interactive";

/**
 * Values of `CI` that mean "not set". Everything else counts as set, because
 * runners spell it `1`, `true` and `yes` in roughly equal measure and a run
 * that guesses wrong hangs forever waiting on a question nobody can see.
 */
const FALSY_CI_VALUES = new Set(["", "0", "false", "no", "off"]);

/**
 * True when sous is attached to a terminal in both directions, was not told to
 * stay quiet, and is not running inside a continuous integration runner.
 *
 * @param inputs - Overrides for the command line, environment and streams.
 */
export function isInteractive(inputs: InteractiveInputs = {}): boolean {
  return nonInteractiveReason(inputs) === undefined;
}

/**
 * Why this run cannot ask a question, as a plain sentence, or undefined when it
 * can. The reason is quoted in the error a blocked prompt raises, because "sous
 * is not running where it can ask" is baffling on its own when the caller is
 * sitting at a terminal and only `CI=1` in their shell made it true.
 *
 * @param inputs - Overrides for the command line, environment and streams.
 */
export function nonInteractiveReason(inputs: InteractiveInputs = {}): string | undefined {
  const argv = inputs.argv ?? process.argv;
  const env = inputs.env ?? process.env;
  const stdinIsTTY = inputs.stdinIsTTY ?? process.stdin.isTTY === true;
  const stdoutIsTTY = inputs.stdoutIsTTY ?? process.stdout.isTTY === true;

  if (hasNonInteractiveFlag(argv)) {
    return `the '${NON_INTERACTIVE_FLAG}' flag was passed`;
  }

  const ci = env.CI;
  if (ci !== undefined && !FALSY_CI_VALUES.has(ci.trim().toLowerCase())) {
    return `the 'CI' environment variable is set to '${ci}'`;
  }

  if (!stdinIsTTY && !stdoutIsTTY) return "neither input nor output is a terminal";
  if (!stdinIsTTY) return "input is not a terminal";
  if (!stdoutIsTTY) return "output is not a terminal";

  return undefined;
}

/**
 * True when the command line carries `--non-interactive`. Scanning stops at a
 * bare `--`, exactly as the config-flag readers do: anything after it belongs to
 * a launched tool, never to sous.
 *
 * @param argv - The raw command line.
 */
function hasNonInteractiveFlag(argv: string[]): boolean {
  for (const arg of argv) {
    if (arg === "--") return false;
    if (arg === NON_INTERACTIVE_FLAG) return true;
  }
  return false;
}

/**
 * A ConfigError raised because a question could not be asked. It carries a flag
 * telling the command layer to print the command's own help underneath it, so
 * the caller sees every flag that could have answered the question.
 */
export class NonInteractiveError extends ConfigError {
  /** Tells `BaseCommand` to print the command's help after this error. */
  readonly showHelp = true;

  constructor(message: string) {
    super(message);
    this.name = "NonInteractiveError";
  }
}

/** True when an error asked for the command's help to be printed with it. */
export function wantsHelp(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { showHelp?: boolean }).showHelp === true
  );
}

/** What a blocked prompt needs to describe itself. */
export type BlockedPrompt = {
  /** The question that could not be asked, named as a person would name it. */
  prompt: string;
  /**
   * How to answer it ahead of time: a flag, or the environment variables. A
   * remedy names the flag's primary spelling, and lists its alternate spellings
   * once, in one parenthetical; the alternates are defined in
   * `utils/flags.ts` and the command's own help (printed underneath this error)
   * lists them too.
   */
  remedy: string;
  /** Extra lines of context, such as the candidates that could not be chosen between. */
  details?: string[];
  /** Overrides for the command line, environment and streams. */
  inputs?: InteractiveInputs;
};

/**
 * Builds the error a blocked prompt raises: what could not be asked, why sous
 * could not ask it, and what would have answered it without a terminal.
 *
 * @param blocked - The prompt, the remedy and any extra context.
 */
export function nonInteractiveError(blocked: BlockedPrompt): NonInteractiveError {
  const reason = nonInteractiveReason(blocked.inputs ?? {}) ?? "there is no terminal to ask on";
  const lines = [
    `Sous has to ask ${blocked.prompt}, and it is not running where it can ask.`,
    `  Why: ${reason}.`,
  ];
  for (const detail of blocked.details ?? []) lines.push(`  ${detail}`);
  lines.push(`  Answer it ahead of time: ${blocked.remedy}`);
  return new NonInteractiveError(lines.join("\n"));
}
