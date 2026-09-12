import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { confirmPrompt, renderConfirmPrompt } from "./confirm-prompt.js";
import { promptBottom } from "./formatting.js";

/** The key legend every sous question carries, in a yes-or-no question's wording. */
const HINT = "y/n answer • ⏎ accept default • ⇥ advanced";

/**
 * The pure renderer behind the yes-or-no question. Everything the prompt draws
 * goes through it, so it can be checked without a terminal.
 */
describe("renderConfirmPrompt()", () => {
  /**
   * The default is the capitalised letter, which is how the stock confirm
   * prompt says which answer Enter alone accepts.
   *
   * renderConfirmPrompt({ prefix: "?", message: "Enable it?", default: true });
   * // -> ["? Enable it? (Y/n)", ""]
   */
  it("should capitalise the preselected default", () => {
    const [yes] = renderConfirmPrompt({ prefix: "?", message: "Enable it?", default: true });
    const [no] = renderConfirmPrompt({ prefix: "?", message: "Enable it?", default: false });
    expect(yes).toBe("? Enable it? (Y/n)");
    expect(no).toBe("? Enable it? (y/N)");
  });

  /**
   * With no default named, the question still offers yes, which is the answer
   * Enter alone accepts.
   */
  it("should offer yes when no default was named", () => {
    const [line] = renderConfirmPrompt({ prefix: "?", message: "Enable it?" });
    expect(line).toBe("? Enable it? (Y/n)");
  });

  /**
   * The legend occupies the line under the question, exactly as it does under
   * the value question, with the padding following it.
   */
  it("should put the hint on the line underneath", () => {
    const [, below] = renderConfirmPrompt({
      prefix: "?",
      message: "Enable it?",
      hint: HINT,
    });
    expect(below).toBe(promptBottom(HINT));
  });

  /** Once the question is answered the legend and the padding go away. */
  it("should drop the legend and the padding once answered", () => {
    const [, below] = renderConfirmPrompt({
      prefix: "V",
      message: "Enable it?",
      hint: HINT,
      answer: true,
    });
    expect(below).toBe("");
  });

  /**
   * A yes or no is never a secret, so the answer is always written out in
   * plain words once it is given. Masking belongs to the value question alone.
   */
  it("should write the answer out in words, since nothing here is ever masked", () => {
    const [yes] = renderConfirmPrompt({ prefix: "?", message: "Enable it?", answer: true });
    const [no] = renderConfirmPrompt({ prefix: "?", message: "Enable it?", answer: false });
    expect(yes).toBe("? Enable it? yes");
    expect(no).toBe("? Enable it? no");
    expect(yes).not.toContain("*");
  });
});

/**
 * The keys the yes-or-no question answers to, driven through a pair of plain
 * streams so no terminal is needed.
 */
describe("confirmPrompt()", () => {
  /**
   * Runs the prompt against fake streams, presses the given keys and hands back
   * how the question ended.
   *
   * @param keys - The characters to write, in order.
   * @param config - The question to ask.
   */
  async function press(
    keys: string[],
    config: Parameters<typeof confirmPrompt>[0]
  ): Promise<unknown> {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const answer = confirmPrompt(config, { input, output });
    for (const key of keys) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      input.write(key);
    }
    return answer;
  }

  /**
   * Tab is the one key every sous question shares: it ends the question with a
   * request for the advanced view instead of answering it.
   */
  it("should resolve with a request for the advanced view when Tab is pressed", async () => {
    const result = await press(["\t"], { message: "Enable it?" });
    expect(result).toEqual({ kind: "advanced" });
  });

  /** Enter alone accepts the default, whichever way it points. */
  it("should accept the default when Enter is pressed", async () => {
    expect(await press(["\r"], { message: "Enable it?", default: false })).toEqual({
      kind: "value",
      value: false,
    });
    expect(await press(["\r"], { message: "Enable it?", default: true })).toEqual({
      kind: "value",
      value: true,
    });
  });

  /** The y and n keys answer the question on their own. */
  it("should answer on the y and n keys", async () => {
    expect(await press(["y"], { message: "Enable it?", default: false })).toEqual({
      kind: "value",
      value: true,
    });
    expect(await press(["n"], { message: "Enable it?", default: true })).toEqual({
      kind: "value",
      value: false,
    });
  });
});
