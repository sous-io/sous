/**
 * The value question sous asks for a recipe variable.
 *
 * It behaves like the stock `input` prompt (typing, backspace, Enter alone
 * accepting the default, a validation message that re-asks) with one addition:
 * Tab resolves the question with `{ kind: "advanced" }` instead of inserting a
 * tab or inlining the default, so the caller can show the advanced view and
 * then ask the same question again. A secret passes `mask`, which hides what is
 * typed. Built on the public `@inquirer/core` hooks only.
 */

import {
  createPrompt,
  isEnterKey,
  isTabKey,
  useKeypress,
  usePrefix,
  useState,
  type Status,
} from "@inquirer/core";

/** What the value question needs in order to ask itself. */
export interface ValuePromptConfig {
  /** The one-line question. */
  message: string;
  /** The value Enter alone accepts. */
  default?: string;
  /** A line under the question, such as the Tab hint. */
  hint?: string;
  /** Whether to hide what is typed, for a secret. */
  mask?: boolean;
  /** Checks an answer, returning true or the reason it was refused. */
  validate?: (value: string) => boolean | string | Promise<boolean | string>;
}

/** How the question ended: with an answer, or with a request for the advanced view. */
export type ValuePromptResult = { kind: "value"; value: string } | { kind: "advanced" };

/** Everything the renderer draws, so it can be tested without a terminal. */
export interface ValuePromptView extends Omit<ValuePromptConfig, "validate"> {
  /** The prompt prefix (the question mark, or the check mark once answered). */
  prefix: string;
  /** What has been typed so far. */
  value: string;
  /** The validation message, when the last answer was refused. */
  error?: string;
}

/**
 * Draws the question: prefix, message, the default in parentheses and what has
 * been typed, plus one line underneath carrying the validation message when
 * there is one and the hint otherwise.
 *
 * @param view - The prompt's state.
 * @returns The question line and the line under it.
 */
export function renderValuePrompt(view: ValuePromptView): [string, string] {
  const shown = view.mask === true ? "*".repeat(view.value.length) : view.value;
  const suffix = view.default !== undefined && view.default !== "" ? ` (${view.default})` : "";
  return [`${view.prefix} ${view.message}${suffix}: ${shown}`.trimEnd(), view.error ?? view.hint ?? ""];
}

/** Asks for one value, with Tab bound to the advanced view. */
export const valuePrompt = createPrompt<ValuePromptResult, ValuePromptConfig>((config, done) => {
  const [status, setStatus] = useState<Status>("idle");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const prefix = usePrefix({ status });

  useKeypress(async (key, rl) => {
    if (status !== "idle") return;

    if (isTabKey(key)) {
      // Readline has already put a literal tab in the buffer; take it back out.
      rl.clearLine(0);
      rl.write(value);
      setStatus("done");
      done({ kind: "advanced" });
      return;
    }

    if (isEnterKey(key)) {
      const answer = value === "" ? (config.default ?? "") : value;
      setStatus("loading");
      const checked = config.validate === undefined ? true : await config.validate(answer);
      if (checked === true) {
        setValue(answer);
        setStatus("done");
        done({ kind: "value", value: answer });
        return;
      }
      rl.write(value);
      setError(typeof checked === "string" ? checked : "That answer is not valid.");
      setStatus("idle");
      return;
    }

    setValue(rl.line);
    setError(undefined);
  });

  return renderValuePrompt({
    prefix,
    message: config.message,
    value,
    ...(config.default === undefined ? {} : { default: config.default }),
    ...(config.hint === undefined ? {} : { hint: config.hint }),
    ...(config.mask === undefined ? {} : { mask: config.mask }),
    ...(error === undefined ? {} : { error }),
  });
});
