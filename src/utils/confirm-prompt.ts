/**
 * The yes-or-no question sous asks for a recipe variable that holds a boolean.
 *
 * It behaves like the stock `confirm` prompt (the y and n keys answer it, Enter
 * alone accepts the default, which is the capitalised letter) with the one
 * addition every sous question shares: Tab resolves the question with
 * `{ kind: "advanced" }`, so the caller can show the advanced view and then ask
 * the same question again. Built on the public `@inquirer/core` hooks only.
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
import { promptBottom } from "./formatting.js";

/** What the yes-or-no question needs in order to ask itself. */
export interface ConfirmPromptConfig {
  /** The one-line question. */
  message: string;
  /** The answer Enter alone accepts. Defaults to yes. */
  default?: boolean;
  /** A line under the question, such as the Tab hint. */
  hint?: string;
}

/** How the question ended: with an answer, or with a request for the advanced view. */
export type ConfirmPromptResult = { kind: "value"; value: boolean } | { kind: "advanced" };

/** Everything the renderer draws, so it can be tested without a terminal. */
export interface ConfirmPromptView {
  /** The prompt prefix (the question mark, or the check mark once answered). */
  prefix: string;
  /** The one-line question. */
  message: string;
  /** The answer Enter alone accepts. Defaults to yes. */
  default?: boolean;
  /** The answer given, once there is one. */
  answer?: boolean;
  /** A line under the question, such as the Tab hint. */
  hint?: string;
}

/**
 * Draws the question: prefix, message and the two keys with the default
 * capitalised, replaced by the answer itself once one is given, plus the hint
 * on the line underneath. A yes or no is never a secret, so nothing here is
 * ever masked.
 *
 * @param view - The prompt's state.
 * @returns The question line and the line under it.
 */
export function renderConfirmPrompt(view: ConfirmPromptView): [string, string] {
  const fallback = view.default ?? true;
  const keys = fallback ? "(Y/n)" : "(y/N)";
  const tail = view.answer === undefined ? keys : view.answer ? "yes" : "no";
  const line = `${view.prefix} ${view.message} ${tail}`.trimEnd();

  if (view.answer !== undefined) return [line, ""];
  return [line, promptBottom(view.hint ?? "")];
}

/** Asks one yes-or-no question, with Tab bound to the advanced view. */
export const confirmPrompt = createPrompt<ConfirmPromptResult, ConfirmPromptConfig>(
  (config, done) => {
    const [status, setStatus] = useState<Status>("idle");
    const [answer, setAnswer] = useState<boolean | undefined>(undefined);
    const prefix = usePrefix({ status });

    /** Settles the question with one answer, and draws it in place of the keys. */
    const settle = (value: boolean): void => {
      setAnswer(value);
      setStatus("done");
      done({ kind: "value", value });
    };

    useKeypress((key, rl) => {
      if (status !== "idle") return;
      // Readline echoes whatever was pressed into its buffer; take it back out.
      rl.clearLine(0);

      if (isTabKey(key)) {
        setStatus("done");
        done({ kind: "advanced" });
        return;
      }

      if (isEnterKey(key)) {
        settle(config.default ?? true);
        return;
      }

      if (key.name === "y") settle(true);
      else if (key.name === "n") settle(false);
    });

    return renderConfirmPrompt({
      prefix,
      message: config.message,
      ...(config.default === undefined ? {} : { default: config.default }),
      ...(answer === undefined ? {} : { answer }),
      ...(config.hint === undefined ? {} : { hint: config.hint }),
    });
  }
);
