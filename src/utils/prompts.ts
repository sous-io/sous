import { confirm as inquire } from "@inquirer/prompts";
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
 * True when sous is attached to a terminal in both directions, which is what it
 * takes to ask a question. A piped or scripted run has to be told what to do
 * with a flag instead.
 */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
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
