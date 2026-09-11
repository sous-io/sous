/**
 * Answering a recipe's questions before it asks them.
 *
 * A person subscribing at a terminal answers each question as it comes. A
 * script, a continuous integration job or an agent has no terminal and knows
 * every answer already, so it supplies them up front: `--answer name=value`,
 * repeated, or a file of the same pairs. Both `sous subscription add` and
 * `sous vars ask` take them, and both hand them here, so the rules are written
 * once.
 *
 * The rules are deliberately unforgiving, because a supplied answer is never
 * seen by a human before it is stored:
 *
 *   - Every answer is validated against its definition BEFORE anything is
 *     written, so a run either stores all of them or none of them.
 *   - A name no recipe declares fails the run and lists every variable the
 *     closure does declare, so a typo can never become a stored value under a
 *     name nothing reads.
 *   - An answer for a variable that already has one replaces it, where it
 *     already lives, and the report says so.
 */

import path from "node:path";
import { ConfigError } from "../errors.js";
import { updateEnvFile } from "../env-file.js";
import { loadManifestFile } from "../repos/load-manifest.js";
import {
  answerFileFor,
  answerHeader,
  type AnsweredVariable,
  type AskOptions,
  type StoragePlan,
} from "./ask.js";
import {
  definedVariableKey,
  definingRecipeKey,
  type DefinedVariable,
} from "./definition-source.js";
import { displayValue } from "./display.js";
import {
  recordAnswerInContext,
  resolveVariable,
  type LadderContext,
} from "./ladder.js";
import { bareName } from "./names.js";
import { validateAnswer } from "./validate.js";

/** How an answer supplied on the command line is written. */
export const ANSWER_FLAG_FORM = "--answer <name>=<value>";

/** The sentence appended to every error about a supplied answer. */
export const ANSWER_NAME_HELP =
  "A name is spelled exactly as the recipe declares it, in camelCase; the full " +
  "'namespace/recipe.name' key works too.";

/** One answer supplied ahead of the questions. */
export interface ProvidedAnswer {
  /** The variable's declared name, or its `namespace/recipe.name` key. */
  name: string;
  /** The answer, exactly as it was written. */
  value: string;
  /** Where it came from, named in every error: the flag, or the file's path. */
  from: string;
}

/**
 * Splits one `name=value` pair. The split is on the FIRST `=` only, so a value
 * may contain as many more as it likes (a connection string, a query, a base64
 * blob).
 *
 * @param entry - The pair as written on the command line.
 * @param from - Where it came from, named in the error.
 *
 * @example
 * parseAnswerPair("apiUrl=https://x.test/?a=1&b=2");
 * // -> { name: "apiUrl", value: "https://x.test/?a=1&b=2", from: "--answer" }
 */
export function parseAnswerPair(entry: string, from = ANSWER_FLAG_FORM): ProvidedAnswer {
  const at = entry.indexOf("=");
  const name = at === -1 ? "" : entry.slice(0, at).trim();

  if (at === -1 || name.length === 0) {
    throw new ConfigError(
      `'${entry}' is not an answer sous can read.\n` +
        `  Write one as '${ANSWER_FLAG_FORM}', for example ` +
        `'--answer apiUrl=https://api.example.com'.\n` +
        `  Everything after the first '=' is the answer, so a value may contain more of them.`
    );
  }

  return { name, value: entry.slice(at + 1), from };
}

/**
 * Reads a file of answers: a YAML or JSON map of the same `name: value` pairs.
 * It goes through the manifest loader, so the JSON dialect is the permissive
 * one and a file can carry comments explaining its answers.
 *
 * @param filePath - Absolute path to the answers file.
 */
export function loadAnswersFile(filePath: string): ProvidedAnswer[] {
  const raw = loadManifestFile(filePath);

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(
      `The answers file at ${filePath} is not a map of answers.\n` +
        `  It holds one entry per variable, written as 'name: value'.`
    );
  }

  const answers: ProvidedAnswer[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "object" && value !== null) {
      throw new ConfigError(
        `The answer for '${name}' in ${filePath} is a list or a map, and an answer is a ` +
          `single value.\n` +
          `  Answers are stored in environment files, which hold text; write the answer ` +
          `as a string, a number or a boolean.`
      );
    }
    if (value === null || value === undefined) {
      throw new ConfigError(
        `The answer for '${name}' in ${filePath} is empty.\n` +
          `  Write the value the variable should be given, or leave the entry out ` +
          `entirely so sous asks for it.`
      );
    }
    answers.push({ name: name.trim(), value: String(value), from: filePath });
  }

  return answers;
}

/** The two ways a caller supplies answers ahead of the questions. */
export interface ProvidedAnswerInputs {
  /** Every `--answer name=value` pair, in the order they were written. */
  answer?: string[];
  /** A file of `name: value` pairs, absolute or relative to `cwd`. */
  answersFile?: string;
  /** Where a relative answers file is resolved from. Defaults to the real cwd. */
  cwd?: string;
}

/**
 * Collects every supplied answer into one list, with the file read first and
 * the flags laid over it, so `--answer` wins over the file for the same name.
 * A name given twice in the same place keeps the last one written, which is how
 * every other repeated flag behaves.
 *
 * @param inputs - The flag values, and where a relative file path resolves from.
 */
export function collectProvidedAnswers(inputs: ProvidedAnswerInputs): ProvidedAnswer[] {
  const collected = new Map<string, ProvidedAnswer>();

  if (inputs.answersFile !== undefined) {
    const filePath = path.resolve(inputs.cwd ?? process.cwd(), inputs.answersFile);
    for (const answer of loadAnswersFile(filePath)) collected.set(answer.name, answer);
  }

  for (const entry of inputs.answer ?? []) {
    const answer = parseAnswerPair(entry);
    collected.set(answer.name, answer);
  }

  return [...collected.values()];
}

/** True when a supplied name names this variable, by declared name or by key. */
function matchesName(defined: DefinedVariable, name: string): boolean {
  return defined.definition.name === name || definedVariableKey(defined) === name;
}

/**
 * The error a name nothing declares fails with: every variable the closure DOES
 * declare, grouped by the recipe that published it, so the caller can see the
 * spelling they meant rather than guessing at it again.
 *
 * @param answer - The supplied answer whose name matched nothing.
 * @param defined - Every variable definition in play.
 */
export function unknownAnswerError(
  answer: ProvidedAnswer,
  defined: DefinedVariable[]
): ConfigError {
  const lines = [
    `Nothing in this project defines a variable called '${answer.name}', so the answer ` +
      `given with ${answer.from} cannot be stored.`,
  ];

  if (defined.length === 0) {
    lines.push(
      "  No recipe this project subscribes to defines any variables yet, so there is " +
        "nothing to answer."
    );
    return new ConfigError(lines.join("\n"));
  }

  const groups = new Map<string, string[]>();
  for (const entry of defined) {
    const key = definingRecipeKey(entry.recipe);
    const names = groups.get(key) ?? [];
    if (!names.includes(entry.definition.name)) names.push(entry.definition.name);
    groups.set(key, names);
  }

  lines.push("", "  These are the variables in play, and the recipes that declare them:", "");
  for (const [key, names] of groups) {
    lines.push(`    ${key}`);
    for (const name of names) lines.push(`      ${name}`);
  }
  lines.push("", `  ${ANSWER_NAME_HELP}`);

  return new ConfigError(lines.join("\n"));
}

/**
 * The error a supplied answer that does not fit its definition fails with: the
 * variable, the constraint it violated, and the publisher's own example of a
 * real answer. A secret's value is never echoed back.
 *
 * @param answer - The supplied answer.
 * @param defined - The definition it was checked against.
 * @param message - The plain-language reason from `validateAnswer`.
 */
export function invalidAnswerError(
  answer: ProvidedAnswer,
  defined: DefinedVariable,
  message: string
): ConfigError {
  const { definition } = defined;
  return new ConfigError(
    `The answer given for '${answer.name}' does not fit the definition ` +
      `${definingRecipeKey(defined.recipe)} publishes.\n` +
      `  ${message}\n` +
      `  For example: ${String(definition.example)}\n` +
      `  The answer given with ${answer.from} was: ` +
      `${displayValue(answer.value, definition.secret)}\n` +
      `  Nothing was written; fix the answer and run the command again.`
  );
}

/** What one run of `applyProvidedAnswers` did. */
export interface AppliedAnswers {
  /** Every answer that was stored, in the shape the ask report prints. */
  stored: AnsweredVariable[];
  /**
   * The keys of every variable these answers settled. `askForMissing` skips
   * them, so a supplied answer is never asked about as well as stored.
   */
  keys: string[];
}

/**
 * Where a supplied answer goes. A variable with no answer yet is stored exactly
 * where the interactive flow would store it: under its declared name, in the
 * file its scope asks for. A variable that ALREADY has an answer in one of the
 * project's env files is overwritten where that answer lives, because storing
 * the new value somewhere less specific would leave the old one winning and the
 * caller asking why nothing changed.
 *
 * @param defined - The variable being answered.
 * @param context - The environment layers, as they stand.
 */
export function preAnswerPlan(
  defined: DefinedVariable,
  context: LadderContext
): { plan: StoragePlan; replaced?: string; shadowedBy?: string } {
  const fallback: StoragePlan = {
    file: answerFileFor(defined.definition),
    envName: bareName(defined.definition),
  };
  const existing = resolveVariable(defined, context);

  if (existing === undefined) return { plan: fallback };

  // A value the shell environment supplies is not sous's to rewrite, and it
  // outranks both env files for as long as it is set; the answer is stored
  // where it belongs and the report says what is covering it.
  if (existing.source.file === "shell") {
    return { plan: fallback, replaced: existing.value, shadowedBy: existing.source.envName };
  }

  return {
    plan: { file: existing.source.file, envName: existing.source.envName },
    replaced: existing.value,
  };
}

/** One supplied answer, matched to a definition and coerced to its stored form. */
export interface ApplicableAnswer {
  /** The answer as it was supplied. */
  answer: ProvidedAnswer;
  /** The definition it answers. */
  target: DefinedVariable;
  /** The validated answer, in the form an env file holds. */
  value: string;
}

/**
 * Matches every supplied answer to the definitions it answers and checks it
 * against each of them, without writing anything.
 *
 * A command calls this early, before it installs or writes anything at all, so
 * a bad answer fails the run cleanly rather than halfway through it. One name
 * can answer more than one definition, because two recipes may declare the same
 * variable; every one of them has to accept the value.
 *
 * @param defined - Every variable definition in play.
 * @param provided - The answers supplied ahead of the questions.
 * @returns One entry per definition each answer applies to.
 */
export function validateProvidedAnswers(
  defined: DefinedVariable[],
  provided: ProvidedAnswer[]
): ApplicableAnswer[] {
  const applicable: ApplicableAnswer[] = [];

  for (const answer of provided) {
    const targets = defined.filter((entry) => matchesName(entry, answer.name));
    if (targets.length === 0) throw unknownAnswerError(answer, defined);

    for (const target of targets) {
      const validated = validateAnswer(target.definition, answer.value);
      if (!validated.ok) throw invalidAnswerError(answer, target, validated.message);
      applicable.push({ answer, target, value: String(validated.value) });
    }
  }

  return applicable;
}

/**
 * Validates every supplied answer, then stores them all.
 *
 * Validation happens for all of them first, so a run with one bad answer in it
 * writes nothing at all rather than half of what it was given. A dry run
 * validates and reports without writing, but still records the answers in the
 * context it was handed, so the rest of the run plans as though they were
 * stored.
 *
 * @param defined - Every variable definition in play.
 * @param provided - The answers supplied ahead of the questions.
 * @param context - The environment layers, updated as answers are stored.
 * @param options - Where to write, and whether this is a dry run.
 * @returns What was stored, and which variables no longer need asking.
 */
export function applyProvidedAnswers(
  defined: DefinedVariable[],
  provided: ProvidedAnswer[],
  context: LadderContext,
  options: AskOptions
): AppliedAnswers {
  const applicable = validateProvidedAnswers(defined, provided);

  const stored: AnsweredVariable[] = [];
  const keys: string[] = [];
  /** Env entries this run has already written, so one file line is written once. */
  const written = new Set<string>();

  for (const entry of applicable) {
    keys.push(definedVariableKey(entry.target));

    const { plan, replaced, shadowedBy } = preAnswerPlan(entry.target, context);
    const filePath = path.join(options.sousDir, plan.file);
    const slot = `${plan.file}:${plan.envName}`;
    if (written.has(slot)) continue;
    written.add(slot);

    const outcome =
      options.dryRun === true
        ? ("not written" as const)
        : updateEnvFile(filePath, plan.envName, entry.value, {
            header: answerHeader(entry.target),
          });

    // Recorded even on a dry run: everything after this point should plan as
    // though the answer were already stored.
    recordAnswerInContext(context, plan.file, plan.envName, entry.value);

    stored.push({
      defined: entry.target,
      envName: plan.envName,
      file: plan.file,
      filePath,
      value: entry.value,
      outcome,
      ...(replaced === undefined || replaced === entry.value ? {} : { replaced }),
      ...(shadowedBy === undefined ? {} : { shadowedBy }),
    });
  }

  return { stored, keys };
}
