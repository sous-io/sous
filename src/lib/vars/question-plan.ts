/**
 * The questions a subscription is going to ask, written out before it asks any
 * of them.
 *
 * A dry run is how a caller with no terminal finds out what a subscription
 * wants: every variable the closure declares, what each one is for, where its
 * answer will be stored, and whether something already answers it. With that in
 * hand the whole subscription can be done in one more command, every answer
 * supplied with `--answer`.
 *
 * The facts are laid out by the renderer `sous vars show` uses, so the labels
 * and the vocabulary are the same wherever a variable is described.
 */

import path from "node:path";
import { color } from "@oclif/color";
import { palette, wrapColumns, wrapText } from "../../utils/formatting.js";
import { answerFileFor, type AnswerFile } from "./ask.js";
import { definingRecipeKey, type DefinedVariable } from "./definition-source.js";
import { renderFacts, type LabeledFact } from "./display.js";
import { describeSource, resolveVariable, type LadderContext } from "./ladder.js";
import { bareName } from "./names.js";
import { validateAnswer } from "./validate.js";

/** One question the closure would ask, and what would happen to its answer. */
export interface PlannedVariable {
  /** The variable and the recipe that published it. */
  defined: DefinedVariable;
  /** The environment variable the answer would be stored under. */
  storedAs: string;
  /** The env file it would be stored in. */
  file: AnswerFile;
  /** That file's absolute path. */
  filePath: string;
  /** True when something already answers this variable, and the answer fits. */
  answered: boolean;
  /** Where the existing answer came from, in plain language. */
  answeredFrom?: string;
}

/** What `planQuestions` needs beyond the definitions themselves. */
export interface QuestionPlanOptions {
  /** The project's `.sous/` directory, which holds both env files. */
  sousDir: string;
}

/**
 * The first sentence of a description, which is what a plan shows; the rest is
 * in `sous vars show <name>`.
 *
 * @param text - The publisher's description.
 */
export function firstSentence(text: string): string {
  const match = /^.*?[.!?](?=\s|$)/s.exec(text.trim());
  return (match?.[0] ?? text.trim()).replace(/\s+/g, " ");
}

/**
 * Works out, for every variable in play, where its answer would go and whether
 * anything answers it already.
 *
 * @param defined - Every variable definition the closure declares.
 * @param context - The environment layers and mapping records to resolve against.
 * @param options - Where the project's env files live.
 */
export function planQuestions(
  defined: DefinedVariable[],
  context: LadderContext,
  options: QuestionPlanOptions
): PlannedVariable[] {
  return defined.map((entry) => {
    const file = answerFileFor(entry.definition);
    const existing = resolveVariable(entry, context);
    const answered =
      existing !== undefined &&
      validateAnswer(entry.definition, existing.value, {
        recipe: definingRecipeKey(entry.recipe),
      }).ok;

    return {
      defined: entry,
      storedAs: answered ? existing!.source.envName : bareName(entry.definition),
      file,
      filePath: path.join(options.sousDir, file),
      answered,
      ...(answered ? { answeredFrom: describeSource(existing!.source) } : {}),
    };
  });
}

/** "1 question" or "3 questions", so no count is printed with the wrong noun. */
function questionCount(count: number): string {
  return count === 1 ? "1 question" : `${count} questions`;
}

/** The labeled facts one planned question shows. */
export function plannedVariableFacts(planned: PlannedVariable): LabeledFact[] {
  const { definition } = planned.defined;

  return [
    { label: "about", lines: [firstSentence(definition.description)] },
    { label: "example", lines: [String(definition.example)] },
    { label: "stored-as", lines: [planned.storedAs] },
    { label: "storage-path", lines: [planned.filePath] },
    {
      label: "answered",
      lines: [
        planned.answered
          ? `yes, from ${planned.answeredFrom}`
          : definition.required
            ? "no, and this recipe requires an answer"
            : "no, and an answer is optional",
      ],
    },
    { label: "answer-with", lines: [`--answer ${definition.name}=<value>`] },
  ];
}

/** What `formatQuestionPlan` needs beyond the questions themselves. */
export interface QuestionPlanFormatOptions {
  /** The column to wrap descriptions at. */
  width?: number;
  /**
   * Recipes in the closure whose files are not on this machine, so their
   * manifests could not be read. They are named in the plan rather than
   * silently left out of it.
   */
  unreadable?: string[];
}

/**
 * The one line that names the recipes a dry run could not read. A dry run
 * downloads nothing, so a recipe this machine does not hold yet has no manifest
 * to read; saying so by name is more useful than leaving it out of the plan.
 *
 * @param unreadable - The recipe keys whose manifests could not be read.
 */
function unreadableLine(unreadable: string[]): string {
  return (
    `Not on this machine yet, so their questions cannot be listed: ` +
    `${unreadable.join(", ")}. A dry run downloads nothing; run this command ` +
    `again without '--dry-run' to install them and be asked.`
  );
}

/**
 * The whole plan as lines to print: one block per recipe, one labeled fact
 * sheet per variable, a line naming any recipe that could not be read, and a
 * closing sentence naming how to answer them all ahead of time.
 *
 * @param planned - Every question the closure would ask.
 * @param options - The wrap column, and any recipes that could not be read.
 * @returns The lines to print, without indentation.
 */
export function formatQuestionPlan(
  planned: PlannedVariable[],
  options: QuestionPlanFormatOptions = {}
): string[] {
  const unreadable = options.unreadable ?? [];

  const columns = options.width ?? wrapColumns();
  /** Wraps one sentence to the width the caller's indentation leaves for it. */
  const sentence = (text: string, paint = (line: string): string => line): string[] =>
    wrapText(text, columns - 2).map(paint);

  if (planned.length === 0) {
    return unreadable.length === 0
      ? sentence("None of these recipes ask any questions, so nothing needs answering.")
      : sentence(unreadableLine(unreadable), palette.note);
  }

  const unanswered = planned.filter((entry) => !entry.answered).length;
  // When part of the closure could not be read, the count below describes only
  // the part that could, and the sentence says so rather than overstating it.
  const subject =
    unreadable.length === 0 ? "These recipes ask" : "The recipes sous could read ask";

  const lines: string[] = sentence(
    unanswered === 0
      ? `${subject} ${questionCount(planned.length)}, and everything they ask ` +
        `is already answered.`
      : `${subject} ${questionCount(planned.length)}, ` +
        `${unanswered} of which nothing answers yet.`
  );

  const groups = new Map<string, PlannedVariable[]>();
  for (const entry of planned) {
    const key = definingRecipeKey(entry.defined.recipe);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }

  for (const [key, entries] of groups) {
    lines.push("", `${key} asks ${questionCount(entries.length)}:`);
    for (const entry of entries) {
      lines.push("", `  ${color.cyan(entry.defined.definition.name)}`);
      // The facts block indents itself, so the plan adds nothing on top of it.
      lines.push(...renderFacts(plannedVariableFacts(entry), columns - 2));
    }
  }

  if (unreadable.length > 0) {
    lines.push("", ...sentence(unreadableLine(unreadable), palette.note));
  }

  if (unanswered > 0) {
    lines.push(
      "",
      ...sentence(
        "Answer them all ahead of time by running this command again without " +
          "'--dry-run', with one '--answer <name>=<value>' for each, or with " +
          "'--answers-file <path>'.",
        palette.note
      )
    );
  }

  return lines;
}
