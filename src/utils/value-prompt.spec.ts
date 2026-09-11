import { describe, expect, it } from "vitest";
import { renderValuePrompt } from "./value-prompt.js";

/**
 * The pure renderer behind the value question. Everything the prompt draws goes
 * through it, so it can be checked without a terminal.
 */
describe("renderValuePrompt()", () => {
  /**
   * With nothing typed and no default, the question line is the prefix and the
   * message, and the line underneath is empty.
   *
   * renderValuePrompt({ prefix: "?", message: "Where?", value: "" });
   * // -> ["? Where?:", ""]
   */
  it("should draw the bare question when there is nothing to show", () => {
    const [line, below] = renderValuePrompt({ prefix: "?", message: "Where?", value: "" });
    expect(line).toBe("? Where?:");
    expect(below).toBe("");
  });

  /**
   * A default is shown in parentheses after the message, exactly as the stock
   * input prompt shows it, and what has been typed follows the colon.
   */
  it("should show the default in parentheses and the typed value after it", () => {
    const [line] = renderValuePrompt({
      prefix: "?",
      message: "Where should task files be stored?",
      default: ".sous/tasks",
      value: "docs/tasks",
    });
    expect(line).toBe("? Where should task files be stored? (.sous/tasks): docs/tasks");
  });

  /**
   * A masked question never draws the value: one asterisk stands in for each
   * character, so a secret cannot leak into a scrollback buffer.
   */
  it("should mask the value for a secret", () => {
    const [line] = renderValuePrompt({
      prefix: "?",
      message: "What is the token?",
      mask: true,
      value: "abc123",
    });
    expect(line).toBe("? What is the token?: ******");
    expect(line).not.toContain("abc123");
  });

  /**
   * The hint occupies the line under the question until something is refused;
   * the validation message then takes that line, so the two never compete.
   */
  it("should show the hint below, and the validation message in its place", () => {
    const hint = "[TAB for advanced info and options]";
    const [, withHint] = renderValuePrompt({
      prefix: "?",
      message: "Where?",
      value: "",
      hint,
    });
    expect(withHint).toBe(hint);

    const [, withError] = renderValuePrompt({
      prefix: "?",
      message: "Where?",
      value: "x",
      hint,
      error: "taskFileRoot must be at least 2 characters long.",
    });
    expect(withError).toBe("taskFileRoot must be at least 2 characters long.");
  });
});
