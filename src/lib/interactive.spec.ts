import { describe, it, expect } from "vitest";
import {
  isInteractive,
  nonInteractiveError,
  nonInteractiveReason,
  wantsHelp,
  NON_INTERACTIVE_FLAG,
} from "./interactive.js";
import { isConfigError } from "./errors.js";

/**
 * Unit tests for the one rule that decides whether sous may ask a question.
 * Every input that can take the terminal away is covered here, because a wrong
 * answer either hangs a continuous integration run on a question nobody can see
 * or refuses to ask a person sitting right there.
 */

/** A terminal in both directions, no flag, no CI. */
const TERMINAL = { argv: ["node", "sous", "subscribe"], env: {}, stdinIsTTY: true, stdoutIsTTY: true };

describe("isInteractive()", () => {
  /** The ordinary case: a person at a terminal, running sous by hand. */
  it("should be interactive at a terminal with no flag and no CI", () => {
    expect(isInteractive(TERMINAL)).toBe(true);
    expect(nonInteractiveReason(TERMINAL)).toBeUndefined();
  });

  /** The global flag says so outright, whatever the streams look like. */
  it("should not be interactive when --non-interactive is passed", () => {
    const inputs = { ...TERMINAL, argv: ["node", "sous", "subscribe", NON_INTERACTIVE_FLAG] };
    expect(isInteractive(inputs)).toBe(false);
    expect(nonInteractiveReason(inputs)).toContain(NON_INTERACTIVE_FLAG);
  });

  /**
   * Scanning stops at a bare `--`, exactly as the config-flag readers do:
   * everything after it belongs to a launched tool, never to sous.
   */
  it("should ignore --non-interactive after a bare double dash", () => {
    const inputs = { ...TERMINAL, argv: ["node", "sous", "launch", "--", NON_INTERACTIVE_FLAG] };
    expect(isInteractive(inputs)).toBe(true);
  });

  /** Every runner sets CI, and the spellings vary, so all truthy ones count. */
  it("should not be interactive when CI is set to a truthy value", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on", "anything"]) {
      const inputs = { ...TERMINAL, env: { CI: value } };
      expect(isInteractive(inputs)).toBe(false);
      expect(nonInteractiveReason(inputs)).toContain("CI");
    }
  });

  /** A CI variable that is set to a falsy value is not a runner saying so. */
  it("should stay interactive when CI is set to a falsy value", () => {
    for (const value of ["", "0", "false", "no", "off"]) {
      expect(isInteractive({ ...TERMINAL, env: { CI: value } })).toBe(true);
    }
  });

  /** A pipe on either stream means the question would go nowhere. */
  it("should not be interactive when either stream is not a terminal", () => {
    expect(isInteractive({ ...TERMINAL, stdinIsTTY: false })).toBe(false);
    expect(nonInteractiveReason({ ...TERMINAL, stdinIsTTY: false })).toBe(
      "input is not a terminal"
    );

    expect(isInteractive({ ...TERMINAL, stdoutIsTTY: false })).toBe(false);
    expect(nonInteractiveReason({ ...TERMINAL, stdoutIsTTY: false })).toBe(
      "output is not a terminal"
    );

    expect(
      nonInteractiveReason({ ...TERMINAL, stdinIsTTY: false, stdoutIsTTY: false })
    ).toBe("neither input nor output is a terminal");
  });
});

describe("nonInteractiveError()", () => {
  /**
   * The error names the question, says why it could not be asked, and states
   * what would have answered it without a terminal.
   */
  it("should name the prompt, the reason and the remedy", () => {
    const error = nonInteractiveError({
      prompt: "the subscribe confirmation",
      remedy: "pass '--yes' to accept it without being asked.",
      details: ["Two candidates matched 'task-files'."],
      inputs: { ...TERMINAL, env: { CI: "true" } },
    });

    expect(isConfigError(error)).toBe(true);
    expect(wantsHelp(error)).toBe(true);
    expect(error.message).toContain("the subscribe confirmation");
    expect(error.message).toContain("'CI' environment variable");
    expect(error.message).toContain("--yes");
    expect(error.message).toContain("Two candidates matched 'task-files'.");
  });
});
