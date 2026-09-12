/**
 * Asking the questions a project's variable definitions imply.
 *
 * A definition is inert. A question is asked only when a subscribed recipe
 * needs a variable and nothing in scope answers it, or when the answer that IS
 * in scope no longer fits the definition. An answer that is already there is
 * offered back with its scope and source shown and is never asked about again.
 *
 * Answers are stored in the project's own env files: `.sous/.env` for the
 * shared ones, which are committed and shared with the team, and
 * `.sous/.env.local` for machine-specific values and every secret, which is
 * gitignored. The writer preserves the rest of the file exactly.
 *
 * Nothing here prompts unless it was told it may. A non-interactive run with an
 * unanswered required variable fails, naming the exact environment variables
 * that would satisfy it, most specific first, which is the message a continuous
 * integration log needs to be useful.
 */

import path from "node:path";
import { confirm, input as input_, select } from "@inquirer/prompts";
import { color } from "@oclif/color";
import { ENV_DEFAULTS_NAME, ENV_LOCAL_NAME } from "../config-discovery.js";
import { updateEnvFile } from "../env-file.js";
import { ConfigError } from "../errors.js";
import {
  blankLine,
  indent,
  log,
  terminalColumns,
  warning,
  wrapText,
} from "../../utils/formatting.js";
import { choicePrompt } from "../../utils/choice-prompt.js";
import { confirmPrompt } from "../../utils/confirm-prompt.js";
import { valuePrompt } from "../../utils/value-prompt.js";
import { ENV_VAR_NAME_PATTERN } from "../repos/formats/patterns.js";
import { variableReferenceKey } from "../refs/find.js";
import type { VariableDefinition } from "../repos/formats/recipe-manifest.js";
import {
  definedVariableKey,
  definingRecipeKey,
  type DefinedVariable,
} from "./definition-source.js";
import {
  BASIC_FACT_LABELS,
  displayValue,
  renderFacts,
  selectFacts,
  variableFacts,
} from "./display.js";
import {
  describeSource,
  diagnoseVariable,
  lookupEnvName,
  variableCandidates,
  recordAnswerInContext,
  RUNG_LABELS,
  type LadderCandidate,
  type LadderContext,
  type ResolvedVariable,
} from "./ladder.js";
import {
  VAR_MAPPINGS_LAYER_FILENAME,
  formatMappingTarget,
  mappingTargetFor,
  writeMappingRecord,
} from "./mappings.js";
import {
  bareName,
  namespaceScopedName,
  recipeScopedName,
  sharedName,
} from "./names.js";
import { validateAnswer } from "./validate.js";

/** Which env file an answer was written to. */
export type AnswerFile = typeof ENV_LOCAL_NAME | typeof ENV_DEFAULTS_NAME;

/** One answer that was collected and stored. */
export interface AnsweredVariable {
  /** The variable that was answered. */
  defined: DefinedVariable;
  /** The environment variable the answer was stored under. */
  envName: string;
  /** Which env file it went into. */
  file: AnswerFile;
  /** The absolute path of that file. */
  filePath: string;
  /** The stored value. */
  value: string;
  /** Whether the entry was rewritten in place or added at the end. */
  outcome: "updated" | "appended" | "not written";
  /** The mapping record written alongside the answer, when one was needed. */
  mapping?: { envName: string; target: string; filePath: string };
  /**
   * The answer this one replaced, when there was a different one already in
   * scope. Only a supplied answer (`--answer`) replaces anything without being
   * asked first, so the report says plainly when one did.
   */
  replaced?: string;
  /**
   * An environment variable in the real shell environment that answers this
   * variable and therefore outranks the file this answer was written to. The
   * report names it, because the stored answer does nothing until it is unset.
   */
  shadowedBy?: string;
}

/** One variable that already had a valid answer. */
export interface InheritedVariable {
  /** The variable that was already answered. */
  defined: DefinedVariable;
  /** The answer and exactly where it came from. */
  resolved: ResolvedVariable;
}

/** One variable that was left alone, and why. */
export interface SkippedVariable {
  /** The variable that was not answered. */
  defined: DefinedVariable;
  /** A plain-language reason, shown in the report. */
  reason: string;
}

/** What one run of `askForMissing` did. */
export interface AskReport {
  /** Answers collected in this run. */
  answered: AnsweredVariable[];
  /** Answers that were already in scope and still fit. */
  inherited: InheritedVariable[];
  /** Variables that were deliberately left unanswered. */
  skipped: SkippedVariable[];
}

/** How `askForMissing` should behave. */
export interface AskOptions {
  /** The project's `.sous/` directory, which holds both env files. */
  sousDir: string;
  /** The project's `conf.d/` directory, where a mapping record is written. */
  confDir: string;
  /** Whether questions may be asked. A non-interactive run fails instead. */
  interactive: boolean;
  /**
   * Limit the run to these variables. Each entry is a variable's bare name, its
   * `namespace/recipe.name` key, or its fully qualified
   * `repository:namespace/recipe.name` reference. A command that resolved a
   * reference through `src/lib/refs/` passes the fully qualified form, which is
   * the only spelling that cannot mean two variables at once.
   */
  only?: string[];
  /**
   * Variables an answer was supplied for ahead of the run, by
   * `namespace/recipe.name` key. They are neither asked about nor reported
   * here; the caller that stored them reports them itself.
   */
  skip?: string[];
  /** Ask again even when a valid answer is already in scope. */
  reask?: boolean;
  /** Work out what would happen and report it, without writing anything. */
  dryRun?: boolean;
}

/** True when the definition's answer belongs in the gitignored local file. */
export function answerFileFor(definition: VariableDefinition): AnswerFile {
  return definition.secret || definition.scope === "local"
    ? ENV_LOCAL_NAME
    : ENV_DEFAULTS_NAME;
}

/**
 * True when `only` names this variable, by bare name, by its
 * `namespace/recipe.name` key, or by its fully qualified reference.
 */
function isNamed(defined: DefinedVariable, only: string[] | undefined): boolean {
  if (only === undefined) return false;
  const key = definedVariableKey(defined);
  const qualified = variableReferenceKey(defined);
  return only.some(
    (name) => name === defined.definition.name || name === key || name === qualified
  );
}

/** The generated header comment written above a newly stored answer. */
export function answerHeader(defined: DefinedVariable): string[] {
  const recipe = definingRecipeKey(defined.recipe);
  return [
    `Set by sous for ${recipe}: ${defined.definition.prompt}`,
    defined.definition.description,
    "Edit freely; sous only rewrites the value line.",
  ];
}

/**
 * The message a non-interactive run fails with: one block per unanswered
 * variable, naming every environment variable that would satisfy it, most
 * specific first.
 */
function buildNonInteractiveError(
  pending: { defined: DefinedVariable; candidates: LadderCandidate[]; current?: string }[]
): ConfigError {
  const lines: string[] = [
    pending.length === 1
      ? "One variable still needs an answer, and there is no terminal to ask on."
      : `${pending.length} variables still need answers, and there is no terminal to ask on.`,
    "",
    "Set one of the environment variables listed under each variable, or run",
    "'sous vars ask' from a terminal.",
  ];

  for (const entry of pending) {
    lines.push("");
    lines.push(
      `  ${entry.defined.definition.name} (${definingRecipeKey(entry.defined.recipe)}): ` +
        entry.defined.definition.prompt
    );
    if (entry.current !== undefined) {
      lines.push(
        `    The value currently in scope does not fit this variable: ${entry.current}`
      );
    }
    for (const candidate of entry.candidates) {
      lines.push(`    ${candidate.envName}  (${RUNG_LABELS[candidate.rung]})`);
    }
  }

  return new ConfigError(lines.join("\n"));
}

/** Where one answer will be stored: which env file, and under what name. */
export interface StoragePlan {
  /** The env file the answer goes into. */
  file: AnswerFile;
  /** The environment variable name the answer is stored under. */
  envName: string;
}

/** One question sous is going to ask, and the value Enter alone would accept. */
interface PlannedQuestion {
  /** The variable being asked about. */
  defined: DefinedVariable;
  /** The value offered as the default, when there is one. */
  suggestion?: string;
}

/** The questions one recipe contributes, in the order they will be asked. */
interface QuestionGroup {
  /** The recipe's `namespace/recipe` key. */
  key: string;
  /** Whether the project subscribed to this recipe itself. */
  direct: boolean;
  /** The questions, in declaration order. */
  questions: PlannedQuestion[];
}

/** "1 answer" or "4 answers", so no count is ever printed with the wrong noun. */
function answerCount(count: number): string {
  return count === 1 ? "1 answer" : `${count} answers`;
}

/**
 * The single sentence printed before any question when the run spans more than
 * one recipe, so the size of what is about to be asked is known up front. A run
 * covering one recipe needs no lead-in; its own opening line says everything.
 *
 * @param groups - Each recipe, how many questions it contributes, and whether the project subscribed to it directly.
 * @returns The lead-in, or undefined when there is only one recipe.
 *
 * @example
 * askLeadIn([
 *   { key: "workflow/task-files", count: 4, direct: true },
 *   { key: "workflow/sub-agent-delegation", count: 2, direct: false },
 * ]);
 * // -> "workflow/task-files needs 4 answers, and workflow/sub-agent-delegation, which it depends on, needs 2."
 */
export function askLeadIn(
  groups: Array<{ key: string; count: number; direct: boolean }>
): string | undefined {
  if (groups.length < 2) return undefined;

  const parts = groups.map((group, index) => {
    const relation = index === 0 || group.direct ? "" : ", which it depends on,";
    const needs = index === 0 ? answerCount(group.count) : String(group.count);
    return `${group.key}${relation} needs ${needs}`;
  });

  const last = parts.pop()!;
  return `${[...parts, `and ${last}`].join(", ")}.`;
}

/**
 * The opening line of one recipe's questions, printed once before the first of
 * them.
 *
 * @param key - The recipe's `namespace/recipe` key.
 * @param count - How many questions the recipe contributes.
 *
 * @example
 * recipeOpeningLine("workflow/task-files", 4);
 * // -> "workflow/task-files needs 4 answers before it can be used."
 */
export function recipeOpeningLine(key: string, count: number): string {
  return `${key} needs ${answerCount(count)} before it can be used.`;
}

/** Everything the basic view of one question draws. */
export interface BasicViewInput {
  /** The variable being asked about. */
  defined: DefinedVariable;
  /** This question's place in its recipe's run, counting from one. */
  index: number;
  /** How many questions that recipe contributes. */
  total: number;
  /** Where the answer is going, as it stands right now. */
  plan: StoragePlan;
  /** The value Enter alone would accept, when there is one. */
  suggestion?: string;
  /** The column to wrap the description at. */
  width?: number;
}

/**
 * The basic view of one question: the header, the publisher's description
 * wrapped to the terminal, the facts a person needs before typing an answer,
 * and the hint naming the two keys that do anything here. The facts are the
 * same labeled block the advanced view draws, narrowed to four labels, so the
 * two views always read and line up the same way.
 *
 * @param input - The question, its place in the run, and where the answer is going.
 * @param storagePath - The absolute path of the env file the answer goes into.
 * @returns The lines to print, without indentation.
 */
export function basicViewLines(input: BasicViewInput, storagePath: string): string[] {
  const { defined, index, total, plan } = input;
  const { definition } = defined;
  const width = input.width ?? terminalColumns();

  const facts = selectFacts(
    variableFacts({ defined, storagePath, storedAs: plan.envName }),
    BASIC_FACT_LABELS
  );

  return [
    color.bold(`Question ${index} of ${total}: ${color.cyan(definition.name)}`),
    "",
    ...wrapText(definition.description, width),
    "",
    ...renderFacts(facts, width),
    "",
    color.gray(questionHint(definition, input.suggestion)),
  ];
}

/**
 * The one line naming the keys that do anything at a question. Tab always opens
 * the advanced view; what Enter does depends on the kind of question, so a
 * question that is picked from a list says so rather than talking about typing
 * a default.
 *
 * @param definition - The variable being asked about.
 * @param suggestion - The value Enter alone would accept, when there is one.
 * @returns The hint line, without colour.
 *
 * @example
 * questionHint({ type: "enum", ... });
 * // -> "[ENTER to choose; TAB for advanced info and options]"
 */
export function questionHint(
  definition: VariableDefinition,
  suggestion?: string
): string {
  if (definition.type === "enum" || definition.type === "boolean") {
    return "[ENTER to choose; TAB for advanced info and options]";
  }
  return suggestion === undefined || suggestion === ""
    ? "[TAB for advanced info and options]"
    : "[ENTER to accept the default; TAB for advanced info and options]";
}

/**
 * The advanced view of one question: the same header and description, then
 * every fact about the variable, laid out by the renderer `sous vars show`
 * uses, so the vocabulary never drifts between the two.
 *
 * @param input - The question, its place in the run, and where the answer is going.
 * @param storagePath - The absolute path of the env file the answer goes into.
 * @returns The lines to print, without indentation.
 */
export function advancedViewLines(input: BasicViewInput, storagePath: string): string[] {
  const { defined, index, total } = input;
  const width = input.width ?? terminalColumns();

  return [
    color.bold("[Advanced Variable Settings]"),
    "",
    color.bold(`Question ${index} of ${total}: ${color.cyan(defined.definition.name)}`),
    "",
    ...wrapText(defined.definition.description, width),
    "",
    ...renderFacts(
      variableFacts({ defined, storagePath, storedAs: input.plan.envName }),
      width
    ),
  ];
}

/** Prints a block of lines indented under the question, followed by a blank line. */
function printBlock(lines: string[]): void {
  blankLine();
  for (const line of lines) log(line === "" ? " " : indent(line));
  blankLine();
}

/**
 * The value the name picker returns when the name is to be typed by hand. It is
 * lowercase, so it can never collide with an environment variable name, which
 * is always upper snake case.
 */
export const ANOTHER_NAME = "another-name";

/**
 * Every environment variable name the ladder would look this variable up
 * under, in ladder order, as a pick list. Choosing one of these keeps the
 * answer findable with no mapping record at all.
 *
 * @param defined - The variable and the recipe that published it.
 */
export function nameChoices(
  defined: DefinedVariable
): Array<{ name: string; value: string }> {
  const { namespace, name: recipe } = defined.recipe;
  const variable = defined.definition.name;

  const rungs: Array<[string, string]> = [
    ["recipe scope", recipeScopedName(namespace, recipe, variable)],
    ["namespace scope", namespaceScopedName(namespace, variable)],
    ["shared scope", sharedName(variable)],
    ["declared name", bareName(defined.definition)],
  ];

  const seen = new Set<string>();
  const choices: Array<{ name: string; value: string }> = [];
  for (const [label, envName] of rungs) {
    if (seen.has(envName)) continue;
    seen.add(envName);
    choices.push({ name: `${envName}  (${label})`, value: envName });
  }

  choices.push({ name: "Another name, which you type yourself", value: ANOTHER_NAME });
  return choices;
}

/**
 * The two env files an answer can go into, described by what each one means for
 * the team rather than by its name alone.
 */
export function fileChoices(): Array<{ name: string; value: AnswerFile }> {
  return [
    {
      name: `${ENV_DEFAULTS_NAME} (committed, shared with everyone on the project)`,
      value: ENV_DEFAULTS_NAME,
    },
    {
      name: `${ENV_LOCAL_NAME} (gitignored, this machine only)`,
      value: ENV_LOCAL_NAME,
    },
  ];
}

/**
 * The warning shown when a value the definition marked secret or local is about
 * to be pointed at the committed env file. Sous does not prevent it; it says
 * plainly what happens and asks.
 *
 * @param defined - The variable being answered.
 */
export function committedFileWarning(defined: DefinedVariable): string {
  const why = defined.definition.secret
    ? "declared this variable a secret"
    : "declared this variable machine-specific";
  return (
    `${definingRecipeKey(defined.recipe)} ${why}, and ${ENV_DEFAULTS_NAME} is committed ` +
    `to git. An answer stored there enters your project's git history, is pushed with ` +
    `every clone, and is visible to everyone who can read the repository.`
  );
}

/**
 * The advanced view and its menu. It runs until the person answering returns to
 * the value question, and hands back where the answer should be stored: the
 * plan it was given when nothing was changed or the changes were discarded, and
 * the edited plan when they were saved.
 *
 * @param input - The question, its place in the run, and the plan as it stands.
 * @param options - Where the env files live, and whether questions may be asked.
 * @returns The storage plan to use for this answer.
 */
async function runAdvancedView(
  input: BasicViewInput,
  options: AskOptions
): Promise<StoragePlan> {
  const original = input.plan;
  let working: StoragePlan = { ...original };

  for (;;) {
    printBlock(
      advancedViewLines(
        { ...input, plan: working },
        path.join(options.sousDir, working.file)
      )
    );

    const changed = working.file !== original.file || working.envName !== original.envName;
    const choices = [
      changed
        ? { name: "Save changes and return to value entry", value: "save" }
        : { name: "Return to value entry", value: "return" },
      ...(changed
        ? [{ name: "Discard changes and return to value entry", value: "discard" }]
        : []),
      { name: "Change the storage file", value: "file" },
      { name: "Change the stored variable name", value: "name" },
    ];

    const action = await select({ message: "What would you like to do?", choices });

    if (action === "return" || action === "save") return working;
    if (action === "discard") return original;

    if (action === "file") {
      const file = await select({
        message: "Which file should this answer be stored in?",
        choices: fileChoices(),
        default: working.file,
      });

      if (file === ENV_DEFAULTS_NAME && answerFileFor(input.defined.definition) === ENV_LOCAL_NAME) {
        warning(committedFileWarning(input.defined));
        const accepted = await confirm({
          message: `Store this answer in ${ENV_DEFAULTS_NAME} anyway?`,
          default: false,
        });
        if (!accepted) continue;
      }

      working = { ...working, file };
      continue;
    }

    const picked = await select({
      message: "Which environment variable should hold this answer?",
      choices: nameChoices(input.defined),
      default: working.envName,
    });

    if (picked !== ANOTHER_NAME) {
      working = { ...working, envName: picked };
      continue;
    }

    const typed = await input_({
      message: "What should the environment variable be called?",
      default: working.envName,
      validate: (value: string) =>
        ENV_VAR_NAME_PATTERN.test(value.trim())
          ? true
          : "An environment variable name is upper snake case: a letter or underscore, then letters, digits or underscores.",
    });
    working = { ...working, envName: typed.trim() };
  }
}

/** The words a stored boolean may be written with that all mean yes. */
const TRUE_WORDS = ["true", "yes", "y", "on", "1"];

/**
 * Asks the one question the variable's type calls for: a list to pick from for
 * an enum, a yes or no for a boolean, and typing for everything else. All three
 * prompts answer the same way, so Tab reaches the advanced view from every kind
 * of question and the caller has one return path to handle.
 *
 * @param definition - The variable being asked about.
 * @param suggestion - The value Enter alone would accept, when there is one.
 * @param validate - Checks a typed answer; the other two kinds cannot be wrong.
 * @returns The answer as text, or a request for the advanced view.
 */
async function askByType(
  definition: VariableDefinition,
  suggestion: string | undefined,
  validate: (value: string) => true | string
): Promise<{ kind: "value"; value: string } | { kind: "advanced" }> {
  if (definition.type === "enum") {
    const enumOptions = definition.validate?.enum ?? [];
    return choicePrompt({
      message: definition.prompt,
      choices: enumOptions.map((option) => ({ name: option, value: option })),
      ...(suggestion !== undefined && enumOptions.includes(suggestion)
        ? { default: suggestion }
        : {}),
    });
  }

  if (definition.type === "boolean") {
    const current = suggestion ?? String(definition.default ?? "");
    const answered = await confirmPrompt({
      message: definition.prompt,
      default: TRUE_WORDS.includes(current.toLowerCase()),
    });
    return answered.kind === "advanced"
      ? answered
      : { kind: "value", value: String(answered.value) };
  }

  return valuePrompt({
    message: definition.prompt,
    validate,
    ...(suggestion === undefined ? {} : { default: suggestion }),
    ...(definition.secret ? { mask: true } : {}),
  });
}

/**
 * Asks one question and hands back the answer together with where it should be
 * stored. Tab opens the advanced view; returning from it prints the basic view
 * again, with whatever the advanced view changed, and asks once more.
 *
 * @param question - The variable and the value Enter alone would accept.
 * @param place - This question's place in its recipe's run.
 * @param options - Where the env files live.
 * @returns The answer as text, and the storage plan it should be written with.
 */
async function askOneQuestion(
  question: PlannedQuestion,
  place: { index: number; total: number },
  options: AskOptions
): Promise<{ answer: string; plan: StoragePlan }> {
  const { defined } = question;
  const { definition } = defined;

  let plan: StoragePlan = {
    file: answerFileFor(definition),
    envName: bareName(definition),
  };

  const validate = (value: string): true | string => {
    const result = validateAnswer(definition, value, {
      recipe: definingRecipeKey(defined.recipe),
    });
    return result.ok ? true : result.message;
  };

  for (;;) {
    const view: BasicViewInput = {
      defined,
      index: place.index,
      total: place.total,
      plan,
      ...(question.suggestion === undefined ? {} : { suggestion: question.suggestion }),
    };

    printBlock(basicViewLines(view, path.join(options.sousDir, plan.file)));

    // Every kind of question ends the same way: an answer, or a request for the
    // advanced view, which is shown and then hands back here to ask again.
    const result = await askByType(definition, question.suggestion, validate);

    if (result.kind === "value") return { answer: result.value, plan };

    plan = await runAdvancedView(view, options);
  }
}

/**
 * Groups the questions by the recipe that published them, keeping the order
 * they arrived in: the subscribed recipe first, then each dependency in closure
 * order.
 *
 * @param questions - Every question that will be asked, in order.
 */
function groupQuestions(questions: PlannedQuestion[]): QuestionGroup[] {
  const groups = new Map<string, QuestionGroup>();

  for (const question of questions) {
    const key = definingRecipeKey(question.defined.recipe);
    const chain = question.defined.requiredBy;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        direct: chain === undefined || chain.length <= 1,
        questions: [question],
      });
    } else {
      existing.questions.push(question);
    }
  }

  return [...groups.values()];
}

/**
 * Walks every definition, keeps the answers that already fit, asks for the ones
 * that do not, and stores what it collects in the project's env files.
 *
 * Everything is decided before the first question is printed, so the run can
 * say how many answers each recipe needs before it asks for any of them. In a
 * subscribe, this runs strictly after the dependency closure has resolved and
 * every new repository has been trusted; a question is never interleaved with a
 * trust decision.
 *
 * @param defined - Every variable definition in play.
 * @param context - The environment layers and mapping records to resolve against.
 * @param options - Where to write, whether questions may be asked, and what to limit to.
 * @returns What was answered, inherited and skipped.
 */
export async function askForMissing(
  defined: DefinedVariable[],
  context: LadderContext,
  options: AskOptions
): Promise<AskReport> {
  const report: AskReport = { answered: [], inherited: [], skipped: [] };
  const pending: { defined: DefinedVariable; candidates: LadderCandidate[]; current?: string }[] =
    [];
  const questions: PlannedQuestion[] = [];
  const deferred: DefinedVariable[] = [];
  /** Names an earlier question in this same run will write. */
  const plannedNames = new Set<string>();

  for (const entry of defined) {
    if (options.only !== undefined && !isNamed(entry, options.only)) continue;
    if (options.skip?.includes(definedVariableKey(entry)) === true) continue;

    const { definition } = entry;
    const named = options.only !== undefined;
    const diagnosis = diagnoseVariable(entry, context);
    const existing = diagnosis.resolved;
    const validity =
      existing === undefined
        ? undefined
        : validateAnswer(definition, existing.value, {
            recipe: definingRecipeKey(entry.recipe),
          });

    if (existing !== undefined && validity?.ok === true && options.reask !== true && !named) {
      report.inherited.push({ defined: entry, resolved: existing });
      continue;
    }

    // A question earlier in this run is about to answer one of the names this
    // variable resolves under, so it is inherited rather than asked; which name
    // answered is settled once the answer is really stored.
    if (
      existing === undefined &&
      options.reask !== true &&
      !named &&
      diagnosis.candidates.some((candidate) => plannedNames.has(candidate.envName))
    ) {
      deferred.push(entry);
      continue;
    }

    const invalid = existing !== undefined && validity?.ok === false;
    const mustAsk =
      invalid || (existing === undefined && definition.required) || options.reask === true || named;

    if (!mustAsk) {
      report.skipped.push({
        defined: entry,
        reason: "no answer yet, and this variable is optional",
      });
      continue;
    }

    if (!options.interactive) {
      pending.push({
        defined: entry,
        candidates: diagnosis.candidates,
        ...(invalid && validity?.ok === false ? { current: validity.message } : {}),
      });
      continue;
    }

    const suggestion =
      existing !== undefined && validity?.ok === true
        ? existing.value
        : definition.default !== undefined
          ? String(definition.default)
          : undefined;

    plannedNames.add(bareName(definition));
    questions.push({ defined: entry, ...(suggestion === undefined ? {} : { suggestion }) });
  }

  if (pending.length > 0) throw buildNonInteractiveError(pending);

  const groups = groupQuestions(questions);
  const leadIn = askLeadIn(
    groups.map((group) => ({
      key: group.key,
      count: group.questions.length,
      direct: group.direct,
    }))
  );
  if (leadIn !== undefined) {
    blankLine();
    log(indent(leadIn));
  }

  for (const group of groups) {
    blankLine();
    log(indent(recipeOpeningLine(group.key, group.questions.length)));

    for (const [position, question] of group.questions.entries()) {
      await runQuestion(
        question,
        { index: position + 1, total: group.questions.length },
        context,
        options,
        report
      );
    }
  }

  // A variable another answer was expected to cover: if it really is answered
  // now, it is inherited; if it is not, it is asked on its own.
  for (const entry of deferred) {
    const diagnosis = diagnoseVariable(entry, context);
    const validity =
      diagnosis.resolved === undefined
        ? undefined
        : validateAnswer(entry.definition, diagnosis.resolved.value, {
            recipe: definingRecipeKey(entry.recipe),
          });

    if (diagnosis.resolved !== undefined && validity?.ok === true) {
      report.inherited.push({ defined: entry, resolved: diagnosis.resolved });
      continue;
    }

    blankLine();
    log(indent(recipeOpeningLine(definingRecipeKey(entry.recipe), 1)));
    await runQuestion(
      { defined: entry },
      { index: 1, total: 1 },
      context,
      options,
      report
    );
  }

  return report;
}

/**
 * Asks one question, stores the answer, and prints the two lines that say what
 * was stored and where.
 *
 * @param question - The variable and the value Enter alone would accept.
 * @param place - This question's place in its recipe's run.
 * @param context - The environment layers, updated as answers are stored.
 * @param options - Where to write, and whether this is a dry run.
 * @param report - The report to record the outcome in.
 */
async function runQuestion(
  question: PlannedQuestion,
  place: { index: number; total: number },
  context: LadderContext,
  options: AskOptions,
  report: AskReport
): Promise<void> {
  const { answer, plan } = await askOneQuestion(question, place, options);
  const validated = validateAnswer(question.defined.definition, answer, {
    recipe: definingRecipeKey(question.defined.recipe),
  });

  if (!validated.ok) {
    report.skipped.push({ defined: question.defined, reason: validated.message });
    return;
  }

  const stored = await storeAnswer(
    question.defined,
    String(validated.value),
    context,
    options,
    plan
  );
  report.answered.push(stored);

  blankLine();
  log(
    indent(
      `  ${color.cyan(stored.envName)}=${displayValue(
        stored.value,
        question.defined.definition.secret
      )}`
    )
  );
  log(
    indent(
      `  ${options.dryRun === true ? "Would be saved to" : "Saved to"} ${stored.filePath}`
    )
  );
}

/**
 * Stores one answer, in the env file and under the name the plan asks for (the
 * definition's own choices when there is no plan). A name the resolution ladder
 * would never look at, which is what "another name" in the advanced view
 * produces, gets a mapping record so the answer is still found; and when the
 * name the definition asks for is already bound to something that does not fit,
 * a mapping is offered rather than an overwrite.
 *
 * @param defined - The variable being answered.
 * @param value - The validated answer, in its stored form.
 * @param context - The environment layers, updated so later lookups see the answer.
 * @param options - Where to write, and whether this is a dry run.
 * @param plan - Where the answer should go, when the advanced view settled it.
 */
async function storeAnswer(
  defined: DefinedVariable,
  value: string,
  context: LadderContext,
  options: AskOptions,
  plan?: StoragePlan
): Promise<AnsweredVariable> {
  const { definition } = defined;
  const file = plan?.file ?? answerFileFor(definition);
  const filePath = path.join(options.sousDir, file);

  let envName = plan?.envName ?? bareName(definition);
  let mapping: AnsweredVariable["mapping"];

  // A chosen name the ladder never looks at needs a record binding it to this
  // variable, or the answer would be written and then never found again.
  const reachable = variableCandidates(defined, context).some(
    (candidate) => candidate.envName === envName
  );
  if (!reachable) {
    const target = formatMappingTarget(mappingTargetFor(defined));
    const mappingPath =
      options.dryRun === true
        ? path.join(options.confDir, VAR_MAPPINGS_LAYER_FILENAME)
        : writeMappingRecord(options.confDir, envName, target);
    mapping = { envName, target, filePath: mappingPath };
    context.mappings = { ...context.mappings, [envName]: target };
  }

  const occupant = lookupEnvName(envName, context);
  const conflicts =
    mapping === undefined &&
    occupant !== undefined &&
    validateAnswer(definition, occupant.value, { recipe: definingRecipeKey(defined.recipe) }).ok ===
      false;

  if (conflicts) {
    const scopedName = recipeScopedName(
      defined.recipe.namespace,
      defined.recipe.name,
      definition.name
    );
    const target = formatMappingTarget(mappingTargetFor(defined));

    const useMapping = options.interactive
      ? (await select({
          message:
            `${envName} already holds a value that does not fit ${definition.name}. ` +
            "Where should this answer go?",
          choices: [
            { name: `${scopedName}, with a mapping record (recommended)`, value: true },
            { name: `${envName}, replacing what is there`, value: false },
          ],
        })) === true
      : true;

    if (useMapping) {
      envName = scopedName;
      const mappingPath = options.dryRun === true
        ? path.join(options.confDir, VAR_MAPPINGS_LAYER_FILENAME)
        : writeMappingRecord(options.confDir, scopedName, target);
      mapping = { envName: scopedName, target, filePath: mappingPath };
      context.mappings = { ...context.mappings, [scopedName]: target };
    }
  }

  const outcome =
    options.dryRun === true ? "not written" : updateEnvFile(filePath, envName, value, {
      header: answerHeader(defined),
    });

  if (options.dryRun !== true) {
    recordAnswerInContext(context, file, envName, value);
  }

  return { defined, envName, file, filePath, value, outcome, ...(mapping ? { mapping } : {}) };
}

/**
 * Renders an ask report as the lines a command prints: what was answered, what
 * was inherited (always shown, with its scope and source, so an answer that
 * came from somewhere else is never a surprise), and what was left alone.
 *
 * @param report - The report to render.
 * @param dryRun - When true, the wording says what WOULD have been written.
 */
export function formatAskReport(report: AskReport, dryRun = false): string[] {
  const lines: string[] = [];

  if (report.inherited.length > 0) {
    lines.push("Answers already in scope:");
    for (const entry of report.inherited) {
      const shown = displayValue(entry.resolved.value, entry.defined.definition.secret);
      lines.push(`  ${entry.defined.definition.name} = ${shown}`);
      lines.push(`    from ${describeSource(entry.resolved.source)}`);
    }
    lines.push("");
  }

  if (report.answered.length > 0) {
    lines.push(dryRun ? "Answers that would be stored:" : "Answers stored:");
    for (const entry of report.answered) {
      const shown = displayValue(entry.value, entry.defined.definition.secret);
      lines.push(`  ${entry.defined.definition.name} = ${shown}`);
      lines.push(`    ${entry.envName} in ${entry.file}`);
      if (entry.mapping !== undefined) {
        lines.push(`    mapped to ${entry.mapping.target} in the conf.d layer`);
      }
      if (entry.replaced !== undefined) {
        const previous = displayValue(entry.replaced, entry.defined.definition.secret);
        lines.push(
          dryRun
            ? `    replacing the answer already there: ${previous}`
            : `    replaced the answer already there: ${previous}`
        );
      }
      if (entry.shadowedBy !== undefined) {
        lines.push(
          `    ${entry.shadowedBy} is set in your shell environment and answers this ` +
            `variable first; unset it for the stored answer to take effect`
        );
      }
    }
    lines.push("");
  }

  if (report.skipped.length > 0) {
    lines.push("Left unanswered:");
    for (const entry of report.skipped) {
      lines.push(`  ${entry.defined.definition.name}: ${entry.reason}`);
    }
    lines.push("");
  }

  if (lines.length === 0) {
    lines.push("Every variable in play already has an answer that fits its definition.");
  }

  return lines;
}
