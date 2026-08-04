import { confirm as inquire } from "@inquirer/prompts";
import { color } from "@oclif/color";

import { blankLine, blankLines, log } from "./formatting.js";

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
