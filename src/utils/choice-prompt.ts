/**
 * The pick-one question sous asks for a recipe variable with a fixed set of
 * allowed values.
 *
 * It behaves like the stock `select` prompt (arrow keys to move, Enter to
 * choose, the default preselected) with the one addition every sous question
 * shares: Tab resolves the question with `{ kind: "advanced" }` instead of
 * moving the cursor, so the caller can show the advanced view and then ask the
 * same question again. Built on the public `@inquirer/core` hooks only.
 */

import {
  createPrompt,
  isDownKey,
  isEnterKey,
  isTabKey,
  isUpKey,
  useKeypress,
  usePrefix,
  useState,
  type Status,
} from "@inquirer/core";
import { promptBottom } from "./formatting.js";

/** One value the question offers, and how it is written on screen. */
export interface PromptChoice {
  /** The line shown in the list. */
  name: string;
  /** The value handed back when the line is chosen. */
  value: string;
}

/** What the pick-one question needs in order to ask itself. */
export interface ChoicePromptConfig {
  /** The one-line question. */
  message: string;
  /** The values on offer, in the order they are listed. */
  choices: PromptChoice[];
  /** The value that starts out highlighted, so Enter alone accepts it. */
  default?: string;
  /** A line under the list: the key legend, in the stock prompts' style. */
  hint?: string;
}

/** How the question ended: with a choice, or with a request for the advanced view. */
export type ChoicePromptResult = { kind: "value"; value: string } | { kind: "advanced" };

/** Everything the renderer draws, so it can be tested without a terminal. */
export interface ChoicePromptView {
  /** The prompt prefix (the question mark, or the check mark once answered). */
  prefix: string;
  /** The one-line question. */
  message: string;
  /** The values on offer, in the order they are listed. */
  choices: PromptChoice[];
  /** Which choice is highlighted, counting from zero. */
  active: number;
  /** A line under the list: the key legend, in the stock prompts' style. */
  hint?: string;
  /** Whether the question has been answered, which replaces the list with the answer. */
  answered?: boolean;
}

/** The pointer drawn beside the highlighted choice. */
const POINTER = ">";

/**
 * Draws the question: prefix and message on the first line, then one line per
 * choice with a pointer beside the highlighted one, and the hint underneath.
 * Once the question is answered the list gives way to the chosen value, so the
 * scrollback keeps one tidy line per question.
 *
 * @param view - The prompt's state.
 * @returns The question line and the block under it.
 */
export function renderChoicePrompt(view: ChoicePromptView): [string, string] {
  const chosen = view.choices[view.active];

  if (view.answered === true) {
    return [`${view.prefix} ${view.message}: ${chosen?.name ?? ""}`.trimEnd(), ""];
  }

  const lines = view.choices.map(
    (choice, index) => `${index === view.active ? POINTER : " "} ${choice.name}`
  );
  if (view.hint !== undefined && view.hint !== "") lines.push(view.hint);

  return [`${view.prefix} ${view.message}`.trimEnd(), promptBottom(lines.join("\n"))];
}

/** Asks one pick-one question, with Tab bound to the advanced view. */
export const choicePrompt = createPrompt<ChoicePromptResult, ChoicePromptConfig>(
  (config, done) => {
    const [status, setStatus] = useState<Status>("idle");
    const [answered, setAnswered] = useState(false);
    const [active, setActive] = useState(
      Math.max(
        0,
        config.choices.findIndex((choice) => choice.value === config.default)
      )
    );
    const prefix = usePrefix({ status });

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
        const chosen = config.choices[active];
        if (chosen === undefined) return;
        setAnswered(true);
        setStatus("done");
        done({ kind: "value", value: chosen.value });
        return;
      }

      if (isUpKey(key)) {
        setActive((active - 1 + config.choices.length) % config.choices.length);
        return;
      }

      if (isDownKey(key)) {
        setActive((active + 1) % config.choices.length);
      }
    });

    return renderChoicePrompt({
      prefix,
      message: config.message,
      choices: config.choices,
      active,
      ...(config.hint === undefined ? {} : { hint: config.hint }),
      ...(answered ? { answered: true } : {}),
    });
  }
);
