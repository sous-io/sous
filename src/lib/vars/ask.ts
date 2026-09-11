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
import { confirm, input, password, select } from "@inquirer/prompts";
import { ENV_DEFAULTS_NAME, ENV_LOCAL_NAME } from "../config-discovery.js";
import { updateEnvFile } from "../env-file.js";
import { ConfigError } from "../errors.js";
import { blankLine, indent, log } from "../../utils/formatting.js";
import type { VariableDefinition } from "../repos/formats/recipe-manifest.js";
import {
  definedVariableKey,
  definingRecipeKey,
  type DefinedVariable,
} from "./definition-source.js";
import { displayValue, documentationRows } from "./display.js";
import {
  describeSource,
  diagnoseVariable,
  lookupEnvName,
  recordAnswerInContext,
  RUNG_LABELS,
  type LadderCandidate,
  type LadderContext,
  type ResolvedVariable,
} from "./ladder.js";
import {
  formatMappingTarget,
  mappingTargetFor,
  writeMappingRecord,
} from "./mappings.js";
import { bareName, recipeScopedName } from "./names.js";
import { constraintHints, validateAnswer } from "./validate.js";

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
  /** Limit the run to these variable names (or `namespace/recipe.name` keys). */
  only?: string[];
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

/** True when `only` names this variable, by bare name or by full key. */
function isNamed(defined: DefinedVariable, only: string[] | undefined): boolean {
  if (only === undefined) return false;
  const key = definedVariableKey(defined);
  return only.some((name) => name === defined.definition.name || name === key);
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

/**
 * The explanatory block printed above a question: which recipe is asking, what
 * the variable is called, the publisher's description and example, the
 * constraints an answer has to meet, and exactly where the answer will be
 * stored. Every published definition carries a description and an example, so
 * the person answering never has to guess what the one-line question means.
 *
 * @param defined - The variable being asked about, and the recipe that published it.
 * @returns The lines to print, without indentation or trailing blank line.
 */
export function questionBlock(defined: DefinedVariable): string[] {
  const { definition } = defined;
  const rows: Record<string, string> = {
    "Recipe asking": definingRecipeKey(defined.recipe),
    Variable: definition.name,
    ...documentationRows(definition),
    Constraints: constraintHints(definition).join("; "),
    "Stored in": `${answerFileFor(definition)}, as ${bareName(definition)}`,
  };

  const width = Math.max(...Object.keys(rows).map((label) => label.length)) + 1;
  return Object.entries(rows).map(([label, value]) => `${label.padEnd(width)}: ${value}`);
}

/** Prints the explanatory block for one question, followed by a blank line. */
function showQuestionBlock(defined: DefinedVariable): void {
  blankLine();
  for (const line of questionBlock(defined)) log(indent(line));
  blankLine();
}

/** Asks one question, re-asking until the answer fits the definition. */
async function promptForAnswer(
  defined: DefinedVariable,
  suggestion: string | undefined
): Promise<string> {
  const { definition } = defined;
  const message = `${definition.prompt} (${definingRecipeKey(defined.recipe)})`;
  const hints = constraintHints(definition).join("; ");

  showQuestionBlock(defined);

  const validate = (value: string): true | string => {
    const result = validateAnswer(definition, value);
    return result.ok ? true : result.message;
  };

  if (definition.type === "enum") {
    const options = definition.validate?.enum ?? [];
    return select({
      message,
      choices: options.map((option) => ({ name: option, value: option })),
      default: suggestion !== undefined && options.includes(suggestion) ? suggestion : undefined,
    });
  }

  if (definition.type === "boolean") {
    const current = suggestion ?? String(definition.default ?? "");
    const answered = await confirm({
      message,
      default: ["true", "yes", "y", "on", "1"].includes(current.toLowerCase()),
    });
    return String(answered);
  }

  if (definition.secret) {
    return password({ message: `${message} [${hints}]`, mask: true, validate });
  }

  return input({
    message: `${message} [${hints}]`,
    default: suggestion,
    validate,
  });
}

/**
 * Walks every definition, keeps the answers that already fit, asks for the ones
 * that do not, and stores what it collects in the project's env files.
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

  for (const entry of defined) {
    if (options.only !== undefined && !isNamed(entry, options.only)) continue;

    const { definition } = entry;
    const named = options.only !== undefined;
    const diagnosis = diagnoseVariable(entry, context);
    const existing = diagnosis.resolved;
    const validity =
      existing === undefined ? undefined : validateAnswer(definition, existing.value);

    if (existing !== undefined && validity?.ok === true && options.reask !== true && !named) {
      report.inherited.push({ defined: entry, resolved: existing });
      continue;
    }

    const invalid = existing !== undefined && validity?.ok === false;
    const mustAsk = invalid || (existing === undefined && definition.required) || options.reask === true || named;

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

    const answer = await promptForAnswer(entry, suggestion);
    const validated = validateAnswer(definition, answer);
    if (!validated.ok) {
      report.skipped.push({ defined: entry, reason: validated.message });
      continue;
    }

    const stored = String(validated.value);
    report.answered.push(await storeAnswer(entry, stored, context, options));
  }

  if (pending.length > 0) throw buildNonInteractiveError(pending);

  return report;
}

/**
 * Stores one answer, choosing the env file the definition asks for and, when
 * the name it would use is already bound to something that does not fit,
 * offering to record a mapping instead.
 */
async function storeAnswer(
  defined: DefinedVariable,
  value: string,
  context: LadderContext,
  options: AskOptions
): Promise<AnsweredVariable> {
  const { definition } = defined;
  const file = answerFileFor(definition);
  const filePath = path.join(options.sousDir, file);

  let envName = bareName(definition);
  let mapping: AnsweredVariable["mapping"];

  const occupant = lookupEnvName(envName, context);
  const conflicts =
    occupant !== undefined && validateAnswer(definition, occupant.value).ok === false;

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
        ? path.join(options.confDir, "520-var-mappings.json")
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
