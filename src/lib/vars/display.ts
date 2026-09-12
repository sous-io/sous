/**
 * Shared display helpers for the `sous vars` commands: masking secrets, and the
 * labeled facts block both the listing and the ask report use. The tables those
 * commands print are laid out by the shared renderer in `src/utils/table.ts`.
 */

import path from "node:path";
import type { VariableDefinition } from "../repos/formats/recipe-manifest.js";
import {
  formatVariable,
  VARIABLE_INDENT,
  wrapColumns,
  type VariableEntry,
} from "../../utils/formatting.js";
import {
  definingRecipeKey,
  type DefinedVariable,
  type DefiningRecipe,
} from "./definition-source.js";
import { constraintBullets } from "./validate.js";

/** What the value column shows for a secret whose answer is known. */
export const HIDDEN_VALUE = "(hidden)";

/** What the value column shows for a variable nothing has answered. */
export const UNANSWERED_VALUE = "(unanswered)";

/**
 * The display form of a value: a secret never prints, so that a terminal
 * recording, a screen share or a scrollback buffer cannot leak one.
 *
 * @param value - The stored value, or undefined when there is no answer.
 * @param secret - Whether the definition declared the variable a secret.
 */
export function displayValue(value: string | undefined, secret: boolean): string {
  if (value === undefined) return UNANSWERED_VALUE;
  if (secret) return HIDDEN_VALUE;
  return value;
}

/**
 * The two documentation rows every command shows for a variable: the
 * publisher's description, and the sample answer that makes the one-line
 * question concrete. A published definition must carry both, so every caller
 * can show them without checking first.
 *
 * @param definition - The variable definition to document.
 * @returns Label-to-text rows, ready for `showVariables` or an aligned label block.
 */
export function documentationRows(
  definition: VariableDefinition
): Record<string, string> {
  return {
    About: definition.description,
    "For example": String(definition.example),
  };
}

// --- The labeled facts about one variable --------------------------------------------------------

/**
 * One line of a fact: the text, and any secondary detail shown after it in
 * muted grey (a repository location, for instance) rather than in parentheses.
 */
export interface FactLine {
  /** The text shown beside the label. */
  text: string;
  /** The secondary detail that follows it, muted. */
  detail?: string;
}

/** One labeled fact: the label, and the lines shown beside it. */
export interface LabeledFact {
  /**
   * The label, in the plain-word form every key and value display uses
   * (`default`, `required-by`); the `@` the recipe manifests write is not part
   * of it.
   */
  label: string;
  /** The text shown beside the label, one entry per line. */
  lines: Array<string | FactLine>;
}

/** True when a repository location is a URL rather than a path on this machine. */
function isHostedUrl(location: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(location) || location.startsWith("git@");
}

/**
 * Where a recipe's source lives: the repository URL with the recipe's folder
 * appended for a hosted repository, the filesystem path for one read from this
 * machine, and nothing at all when neither was recorded.
 *
 * @param recipe - The recipe to locate.
 */
export function recipeLocation(recipe: DefiningRecipe): string | undefined {
  if (recipe.url !== undefined && isHostedUrl(recipe.url)) {
    const base = recipe.url.replace(/\/+$/, "");
    return recipe.path === undefined ? base : `${base}/${recipe.path}`;
  }

  return recipe.url !== undefined
    ? recipe.path === undefined
      ? recipe.url
      : path.join(recipe.url, recipe.path)
    : recipe.dir;
}

/**
 * A recipe written as a fact line: its key, with its location following it in
 * muted grey. The location is a trailing detail rather than a parenthetical, so
 * the recipe key stays the thing the eye lands on.
 *
 * @param recipe - The recipe to link to.
 */
export function recipeLink(recipe: DefiningRecipe): FactLine {
  const key = definingRecipeKey(recipe);
  const location = recipeLocation(recipe);
  return location === undefined ? { text: key } : { text: key, detail: location };
}

/** Everything the facts renderer needs that the definition itself does not carry. */
export interface VariableFactsInput {
  /** The variable and the recipe that published it. */
  defined: DefinedVariable;
  /** Absolute path of the env file the answer is stored in. */
  storagePath: string;
  /** The environment variable name the answer is stored under. */
  storedAs: string;
}

/**
 * The labeled facts about one variable, in the order both the advanced view and
 * `sous vars show` print them. One function builds them so the two never drift
 * apart in wording or in order.
 *
 * @param input - The variable, where its answer is stored, and under what name.
 * @returns The facts, ready for `renderFacts`.
 */
export function variableFacts(input: VariableFactsInput): LabeledFact[] {
  const { defined, storagePath, storedAs } = input;
  const { definition } = defined;
  const facts: LabeledFact[] = [];

  if (definition.default !== undefined) {
    facts.push({ label: "default", lines: [String(definition.default)] });
  }
  facts.push({ label: "example", lines: [String(definition.example)] });

  const chain = defined.requiredBy ?? [defined.recipe];
  const requiredBy: Array<string | FactLine> = [recipeLink(chain[0] ?? defined.recipe)];
  if (chain.length > 1) {
    requiredBy.push(
      `pulled in through ${chain.map((recipe) => definingRecipeKey(recipe)).join(" then ")}`
    );
  }
  facts.push({ label: "required-by", lines: requiredBy });
  facts.push({ label: "defined-by", lines: [recipeLink(defined.recipe)] });
  facts.push({ label: "storage-path", lines: [storagePath] });
  facts.push({ label: "stored-as", lines: [storedAs] });
  facts.push({
    label: "constraints",
    lines: constraintBullets(definition).map((bullet) => `${BULLET} ${bullet}`),
  });

  return facts;
}

/**
 * The facts the basic view of a question shows, in the order it shows them. It
 * is a subset of the same list the advanced view prints, selected by label, so
 * the two views can never word a fact differently or lay it out differently.
 */
export const BASIC_FACT_LABELS = [
  "default",
  "example",
  "stored-as",
  "storage-path",
];

/**
 * Picks the named facts out of a fact list, in the order the labels were given
 * and skipping any the variable does not have (a variable with no default has
 * no `default` fact).
 *
 * @param facts - Every fact about the variable.
 * @param labels - The labels to keep, in the order they should be shown.
 */
export function selectFacts(facts: LabeledFact[], labels: string[]): LabeledFact[] {
  const byLabel = new Map(facts.map((fact) => [fact.label, fact]));
  return labels
    .map((label) => byLabel.get(label))
    .filter((fact): fact is LabeledFact => fact !== undefined);
}

/**
 * How far a rendered facts block is indented under the text above it. It is the
 * same depth as every other key and value block, so a facts block never reads
 * as a different kind of list.
 */
export const FACTS_INDENT = VARIABLE_INDENT;

/** The character every bulleted line in the CLI is drawn with. */
export const BULLET = "•";

/**
 * Lays the labeled facts out through the one key and value renderer, so a fact
 * about a variable looks exactly like every other key and value sous prints:
 * labels aligned, colons lined up, values in the value color, and a location
 * trailing in muted grey.
 *
 * @param facts - The facts to render.
 * @param width - The column to wrap at, indentation included.
 * @returns The rendered lines, colored for a terminal, indented by `FACTS_INDENT`.
 */
export function renderFacts(facts: LabeledFact[], width = wrapColumns()): string[] {
  const labelWidth = Math.max(...facts.map((fact) => fact.label.length));
  const lines: string[] = [];

  for (const fact of facts) {
    fact.lines.forEach((raw, index) => {
      const line: FactLine = typeof raw === "string" ? { text: raw } : raw;
      const entry: VariableEntry = {
        // A fact needing more than one line labels only the first of them; the
        // rest continue underneath it.
        label: index === 0 ? fact.label : "",
        value: line.text,
        ...(line.detail === undefined ? {} : { detail: line.detail }),
      };
      lines.push(...formatVariable(entry, { indent: FACTS_INDENT, labelWidth, width }));
    });
  }

  return lines;
}
