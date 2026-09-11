import { confirm as inquire, select } from "@inquirer/prompts";
import { color } from "@oclif/color";

import { blankLine, blankLines, log } from "./formatting.js";

/**
 * Ask a yes or no question and hand back the answer, leaving the decision about
 * what to do with a "no" to the caller. `areYouSure` is the variant that ends
 * the process; use this one where a refusal has to be reported rather than
 * simply obeyed.
 *
 * @param prompt - The question to ask.
 * @param defaultAnswer - What Enter alone means. Defaults to no.
 */
export async function askYesNo(prompt: string, defaultAnswer = false): Promise<boolean> {
  blankLine();
  return inquire({ message: prompt, default: defaultAnswer });
}

/**
 * Ask the user to pick one of several choices, handing back the value behind
 * the one they picked. The caller decides the order the choices are shown in;
 * this only draws them.
 *
 * Whether a question may be asked at all is not decided here: that is
 * `isInteractive` in `src/lib/interactive.ts`, the one rule every prompt in
 * sous is gated by.
 *
 * @param prompt - The question to ask.
 * @param choices - The options, in the order they should be listed.
 */
export async function askChoice<T>(
  prompt: string,
  choices: Array<{ name: string; value: T }>
): Promise<T> {
  blankLine();
  return select({ message: prompt, choices });
}

/**
 * Ask the user if they're sure they want to proceed.
 * @param prompt - An optional, custom, prompt to display to the user.
 */
export async function areYouSure(prompt = "Are you SURE you want to proceed?"): Promise<void> {
  blankLine();
  const confirm = await inquire({ message: prompt });
  if (!confirm) {
    blankLine();
    log(color.redBright("Aborting."));
    blankLines();
    process.exit(0);
  }
}
