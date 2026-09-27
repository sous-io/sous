/**
 * How `sous repo submit` asks its questions.
 *
 * The sequencer (`submit-service.ts`) never prompts; it calls a
 * `SubmitQuestions` and carries on with the answer. This module builds that
 * object from the two facts a command knows: whether a question may be asked
 * at all (`src/lib/interactive.ts` decides), and whether the shared
 * confirmation flag already answered every yes-or-no question.
 *
 * A question nobody can ask raises the error that names the flag answering it,
 * so a script learns what to pass rather than hanging on a prompt it cannot see:
 * the title and description name `--title` and `--body` together, and every
 * confirmation names `--yes`.
 */

import { editor } from "@inquirer/prompts";
import { nonInteractiveError } from "../../interactive.js";
import { blankLines, keysHelpTip, log } from "../../../utils/formatting.js";
import { askChoice, askYesNo } from "../../../utils/prompts.js";
import { valuePrompt } from "../../../utils/value-prompt.js";
import type { ProposalSummary } from "../providers/provider.js";
import type { ChangedPath } from "./git-state.js";
import type { NextBranchChoice, SubmitQuestions } from "./submit-service.js";

/** The prompts the questions are asked with; each one is replaceable in a test. */
export type SubmitPrompts = {
  /** Asks for one line of text, with an editor behind Tab for a longer answer. */
  text(message: string): Promise<string>;
  /** Asks a yes-or-no question. */
  confirm(message: string): Promise<boolean>;
  /** Asks the contributor to pick one of several choices. */
  choose<T>(message: string, choices: Array<{ name: string; value: T }>): Promise<T>;
};

/** What `submitQuestions` needs to know. */
export type SubmitQuestionOptions = {
  /** Whether a question may be asked. */
  interactive: boolean;
  /** True when the confirmation flag answered every yes-or-no question already. */
  yes: boolean;
  /** How the questions are put. Defaults to the shared terminal prompts. */
  prompts?: SubmitPrompts;
  /** Where a list shown before a question is written. Defaults to the console. */
  write?: (line: string) => void;
};

/** The flag spellings every confirmation's remedy names. */
const YES_REMEDY = "pass '--yes' (spelled '-y' or '--force' if you prefer)";

/** The remedy for a missing title or description, naming both flags. */
const TEXT_REMEDY =
  "pass '--title' and '--body'. A new proposal, and a commit sous makes for you, both need " +
  "a title and a description written by you.";

/**
 * Builds the questions a submission asks, bound to this run's terminal and
 * flags.
 *
 * @param options - Whether asking is possible, whether `--yes` was passed, and the prompts.
 */
export function submitQuestions(options: SubmitQuestionOptions): SubmitQuestions {
  const prompts = options.prompts ?? terminalPrompts;
  const write = options.write ?? log;
  const { interactive, yes } = options;

  const askText = async (message: string): Promise<string> => {
    if (!interactive) {
      throw nonInteractiveError({
        prompt: "for the proposal's title and description",
        remedy: TEXT_REMEDY,
      });
    }
    return prompts.text(message);
  };

  return {
    title: () => askText("What is the title of this proposal?"),
    body: () => askText("Describe the change: what it does, and why."),

    async confirmCommit(paths: ReadonlyArray<ChangedPath>): Promise<boolean> {
      if (yes) return true;
      write("  These paths are uncommitted, and '--commit' would commit all of them:");
      for (const entry of paths) write(`    ${entry.path}`);
      if (!interactive) {
        throw nonInteractiveError({
          prompt: "whether to commit the paths listed above",
          remedy: `${YES_REMEDY} to commit them without being asked.`,
        });
      }
      return prompts.confirm("Commit these paths?");
    },

    async proceedDespiteSubmissions(): Promise<boolean> {
      if (yes) return true;
      if (!interactive) {
        throw nonInteractiveError({
          prompt: "whether to propose a change to recipes that do not take proposals",
          remedy: `${YES_REMEDY} to propose it anyway.`,
        });
      }
      return prompts.confirm("Propose the change anyway?");
    },

    async nextBranch(merged: ProposalSummary, generated: string): Promise<NextBranchChoice> {
      if (yes) return { kind: "generate" };
      if (!interactive) {
        throw nonInteractiveError({
          prompt: "which new branch to continue on, now the proposal was merged",
          remedy: `${YES_REMEDY} to continue on a branch sous names for you.`,
          details: [`The merged proposal was '${merged.title}'.`],
        });
      }
      const picked = await prompts.choose<"name" | "generate" | "cancel">(
        "Continue on a new branch?",
        [
          { name: `Generate one: ${generated}`, value: "generate" },
          { name: "Name the branch myself", value: "name" },
          { name: "Cancel", value: "cancel" },
        ]
      );
      if (picked !== "name") return { kind: picked };
      const name = (await prompts.text("What should the new branch be called?")).trim();
      return name.length === 0 ? { kind: "generate" } : { kind: "name", name };
    },
  };
}

/**
 * The prompts a real terminal gets. A text question answers on Enter; Tab
 * opens the contributor's editor instead, which is where a description longer
 * than one line is written.
 */
const terminalPrompts: SubmitPrompts = {
  async text(message: string): Promise<string> {
    blankLines(2);
    for (;;) {
      const answered = await valuePrompt({
        message,
        hint: keysHelpTip([
          ["⏎", "answer"],
          ["⇥", "advanced"],
        ]),
        validate: (value) => (value.trim().length > 0 ? true : "An answer is required."),
      });
      if (answered.kind === "value") return answered.value;
      const written = await editor({ message, waitForUserInput: false });
      if (written.trim().length > 0) return written;
    }
  },
  confirm: (message: string) => askYesNo(message),
  choose: <T>(message: string, choices: Array<{ name: string; value: T }>) =>
    askChoice(message, choices),
};
