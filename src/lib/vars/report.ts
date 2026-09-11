/**
 * The two variable reports the `sous vars` commands print.
 *
 * They live here rather than inside a command so that `vars list`, `vars show`
 * and the bare `sous vars` all print exactly the same thing: the listing is one
 * function and the detail is another, and each command only decides which one
 * to call.
 */

import path from "node:path";
import { ConfigError } from "../errors.js";
import {
  definedVariableKey,
  definingRecipeKey,
  type DefinedVariable,
} from "./definition-source.js";
import {
  displayValue,
  documentationRows,
  renderFacts,
  renderTable,
  truncate,
  variableFacts,
} from "./display.js";
import {
  diagnoseVariable,
  RUNG_LABELS,
  SOURCE_LABELS,
  type LadderContext,
} from "./ladder.js";
import { validateAnswer } from "./validate.js";
import { answerFileFor } from "./ask.js";
import { bareName } from "./names.js";
import {
  blankLine,
  heading,
  indent,
  log,
  showVars,
  subheading,
  terminalColumns,
} from "../../utils/formatting.js";

/**
 * Prints the table of every variable in play, sorted by recipe then name.
 *
 * @param defined - Every variable the project's recipes (or a file) define.
 * @param context - The resolution ladder to read answers from.
 */
export function printVariableList(
  defined: DefinedVariable[],
  context: LadderContext
): void {
  heading("Variables in play");

  if (defined.length === 0) {
    blankLine();
    log(
      indent(
        "No recipe in this project defines any variables yet. Subscribe to a recipe " +
          "that publishes some, or read a definitions file with --file."
      )
    );
    return;
  }

  const rows = [...defined]
    .sort((left, right) => definedVariableKey(left).localeCompare(definedVariableKey(right)))
    .map((entry) => {
      const { resolved } = diagnoseVariable(entry, context);
      const value = displayValue(resolved?.value, entry.definition.secret);
      const source =
        resolved === undefined
          ? "nothing yet"
          : `${RUNG_LABELS[resolved.source.rung]}, ${
              SOURCE_LABELS[resolved.source.file] ?? resolved.source.file
            }`;
      return [
        entry.definition.name,
        definingRecipeKey(entry.recipe),
        resolved?.source.envName ?? "",
        truncate(value),
        source,
      ];
    });

  blankLine();
  for (const line of renderTable(
    ["Variable", "Recipe", "Answered by", "Value", "Source"],
    rows
  )) {
    log(indent(line));
  }
}

/** What the detail report needs beyond the definitions themselves. */
export interface VariableDetailOptions {
  /**
   * The project's `.sous/` directory, so the storage path can be shown in full.
   * Without it only the env file's name is shown.
   */
  sousDir?: string;
}

/**
 * Prints everything about one variable: the question, the documentation, the
 * labeled facts (the same block the advanced view of a question prints, from
 * the same renderer), every environment variable name on its resolution ladder,
 * and which rung actually answered.
 *
 * @param defined - Every variable the project's recipes (or a file) define.
 * @param context - The resolution ladder to read answers from.
 * @param name - The variable's name, or its `namespace/recipe.name` key.
 * @param options - Where the project's `.sous/` directory is.
 */
export function printVariableDetail(
  defined: DefinedVariable[],
  context: LadderContext,
  name: string,
  options: VariableDetailOptions = {}
): void {
  const matches = defined.filter(
    (entry) => entry.definition.name === name || definedVariableKey(entry) === name
  );

  if (matches.length === 0) {
    throw new ConfigError(
      `No variable named '${name}' is in play.\n` +
        `  Run 'sous vars list' to see every variable this project's recipes define.`
    );
  }

  for (const entry of matches) {
    const { definition } = entry;
    const { resolved, candidates } = diagnoseVariable(entry, context);
    const validity =
      resolved === undefined ? undefined : validateAnswer(definition, resolved.value);

    const file = answerFileFor(definition);

    heading(`${definition.name} (${definingRecipeKey(entry.recipe)})`);
    blankLine();
    showVars({
      Question: definition.prompt,
      ...documentationRows(definition),
      Recipe: `${definingRecipeKey(entry.recipe)} version ${entry.recipe.version} from ${entry.recipe.repo}`,
      "Stored in": file,
      Value: displayValue(resolved?.value, definition.secret),
      Answer:
        resolved === undefined
          ? "nothing in scope answers this variable yet"
          : validity?.ok === true
            ? "the value in scope fits this definition"
            : `the value in scope does not fit: ${validity?.ok === false ? validity.message : ""}`,
    });

    blankLine();
    const facts = variableFacts({
      defined: entry,
      storagePath:
        options.sousDir === undefined ? file : path.join(options.sousDir, file),
      storedAs: resolved?.source.envName ?? bareName(definition),
    });
    for (const line of renderFacts(facts, terminalColumns() - 2)) log(indent(line));

    blankLine();
    subheading("Environment variables sous looks at, most specific first");
    blankLine();

    const rows = candidates.map((candidate) => [
      candidate.envName,
      RUNG_LABELS[candidate.rung],
      candidate.envName === resolved?.source.envName
        ? `answered it, from ${SOURCE_LABELS[resolved.source.file] ?? resolved.source.file}`
        : "not set",
    ]);
    for (const line of renderTable(["Environment variable", "Rung", "Status"], rows)) {
      log(indent(line));
    }
  }
}
