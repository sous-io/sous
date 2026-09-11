import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { choicePrompt, renderChoicePrompt } from "./choice-prompt.js";

/** The two lines a bare pick-one question is built from, for reuse in the tests. */
const CHOICES = [
  { name: "bash", value: "bash" },
  { name: "zsh", value: "zsh" },
];

/** The hint every sous question carries, in the wording a pick-one question uses. */
const HINT = "[ENTER to choose; TAB for advanced info and options]";

/**
 * The pure renderer behind the pick-one question. Everything the prompt draws
 * goes through it, so it can be checked without a terminal.
 */
describe("renderChoicePrompt()", () => {
  /**
   * The question line carries the prefix and the message; the block under it is
   * one line per choice, with the pointer beside the highlighted one.
   *
   * renderChoicePrompt({ prefix: "?", message: "Which shell?", choices, active: 0 });
   * // -> ["? Which shell?", "> bash\n  zsh"]
   */
  it("should draw the message above the list, with the pointer on the highlighted choice", () => {
    const [line, below] = renderChoicePrompt({
      prefix: "?",
      message: "Which shell?",
      choices: CHOICES,
      active: 0,
    });
    expect(line).toBe("? Which shell?");
    expect(below).toBe("> bash\n  zsh");
  });

  /**
   * The prompt preselects the default by handing the renderer that choice's
   * index, so the pointer starts on the value Enter alone would accept.
   */
  it("should point at the preselected default rather than the first choice", () => {
    const [, below] = renderChoicePrompt({
      prefix: "?",
      message: "Which shell?",
      choices: CHOICES,
      active: 1,
    });
    expect(below).toBe("  bash\n> zsh");
  });

  /**
   * The hint takes the last line of the block, under the list, exactly as it
   * sits under the value question.
   */
  it("should put the hint under the list", () => {
    const [, below] = renderChoicePrompt({
      prefix: "?",
      message: "Which shell?",
      choices: CHOICES,
      active: 0,
      hint: HINT,
    });
    expect(below.split("\n").at(-1)).toBe(HINT);
  });

  /**
   * A choice is picked from a list of published values, so there is nothing to
   * mask: the chosen value is always written out in full. Masking belongs to the
   * value question alone.
   */
  it("should write the chosen value out in full, since nothing here is ever masked", () => {
    const [line, below] = renderChoicePrompt({
      prefix: "?",
      message: "Which shell?",
      choices: CHOICES,
      active: 1,
      hint: HINT,
      answered: true,
    });
    expect(line).toBe("? Which shell?: zsh");
    expect(line).not.toContain("*");
    expect(below).toBe("");
  });
});

/**
 * The keys the pick-one question answers to, driven through a pair of plain
 * streams so no terminal is needed.
 */
describe("choicePrompt()", () => {
  /**
   * Runs the prompt against fake streams, presses the given keys and hands back
   * how the question ended.
   *
   * @param keys - The characters to write, in order.
   * @param config - The question to ask.
   */
  async function press(
    keys: string[],
    config: Parameters<typeof choicePrompt>[0]
  ): Promise<unknown> {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const answer = choicePrompt(config, { input, output });
    for (const key of keys) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      input.write(key);
    }
    return answer;
  }

  /**
   * Tab is the one key every sous question shares: it ends the question with a
   * request for the advanced view instead of choosing anything.
   */
  it("should resolve with a request for the advanced view when Tab is pressed", async () => {
    const result = await press(["\t"], { message: "Which shell?", choices: CHOICES });
    expect(result).toEqual({ kind: "advanced" });
  });

  /**
   * Enter alone chooses whatever is highlighted, which starts out as the
   * default.
   */
  it("should choose the preselected default when Enter is pressed", async () => {
    const result = await press(["\r"], {
      message: "Which shell?",
      choices: CHOICES,
      default: "zsh",
    });
    expect(result).toEqual({ kind: "value", value: "zsh" });
  });

  /**
   * The arrow keys move the pointer, and Enter takes whatever it landed on.
   */
  it("should move the pointer with the arrow keys", async () => {
    const result = await press(["\u001b[B", "\r"], {
      message: "Which shell?",
      choices: CHOICES,
    });
    expect(result).toEqual({ kind: "value", value: "zsh" });
  });
});
