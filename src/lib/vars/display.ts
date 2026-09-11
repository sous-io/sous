/**
 * Shared display helpers for the `sous vars` commands: masking secrets and
 * laying out the aligned table both the listing and the ask report use.
 */

import path from "node:path";
import { color } from "@oclif/color";
import type { VariableDefinition } from "../repos/formats/recipe-manifest.js";
import { wrapText } from "../../utils/formatting.js";
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
 * @returns Label-to-text rows, ready for `showVars` or an aligned label block.
 */
export function documentationRows(
  definition: VariableDefinition
): Record<string, string> {
  return {
    About: definition.description,
    "For example": String(definition.example),
  };
}

/**
 * Shortens a long value for a table cell, keeping the start and marking that
 * the rest was left out.
 *
 * @param value - The text to shorten.
 * @param limit - The longest form to allow.
 */
export function truncate(value: string, limit = 48): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 3)}...`;
}

/**
 * Lays a table out with aligned columns, returning the lines to print. The
 * header row is followed by a rule, and every cell is padded to its column's
 * width; the last column is never padded, so nothing carries trailing spaces.
 *
 * @param headers - The column headings.
 * @param rows - One array of cells per row, matching the headings in length.
 * @returns The rendered lines, colored for a terminal.
 */
export function renderTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length))
  );

  const pad = (cells: string[]): string =>
    cells
      .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index]!)))
      .join("  ")
      .trimEnd();

  const lines = [color.cyan(pad(headers))];
  lines.push(color.gray(pad(widths.map((width) => "-".repeat(width)))));
  for (const row of rows) lines.push(pad(row));
  return lines;
}

// --- The labeled facts about one variable --------------------------------------------------------

/** One labeled fact: the label, and the lines shown beside it. */
export interface LabeledFact {
  /** The label, written in the `@name` form the recipe manifests use. */
  label: string;
  /** The text shown beside the label, one entry per line. */
  lines: string[];
}

/** True when a repository location is a URL rather than a path on this machine. */
function isHostedUrl(location: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(location) || location.startsWith("git@");
}

/**
 * A recipe written as a link: its key, and where its source lives. A hosted
 * repository shows its URL with the recipe's folder appended; a repository read
 * from this machine shows the filesystem path instead. A recipe whose location
 * nothing recorded shows its key alone.
 *
 * @param recipe - The recipe to link to.
 */
export function recipeLink(recipe: DefiningRecipe): string {
  const key = definingRecipeKey(recipe);

  if (recipe.url !== undefined && isHostedUrl(recipe.url)) {
    const base = recipe.url.replace(/\/+$/, "");
    return `${key} (${recipe.path === undefined ? base : `${base}/${recipe.path}`})`;
  }

  const local =
    recipe.url !== undefined
      ? recipe.path === undefined
        ? recipe.url
        : path.join(recipe.url, recipe.path)
      : recipe.dir;

  return local === undefined ? key : `${key} (${local})`;
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
    facts.push({ label: "@default", lines: [String(definition.default)] });
  }
  facts.push({ label: "@example", lines: [String(definition.example)] });

  const chain = defined.requiredBy ?? [defined.recipe];
  const requiredBy = [recipeLink(chain[0] ?? defined.recipe)];
  if (chain.length > 1) {
    requiredBy.push(
      `pulled in through ${chain.map((recipe) => definingRecipeKey(recipe)).join(" then ")}`
    );
  }
  facts.push({ label: "@required-by", lines: requiredBy });
  facts.push({ label: "@defined-by", lines: [recipeLink(defined.recipe)] });
  facts.push({ label: "@storage-path", lines: [storagePath] });
  facts.push({ label: "@stored-as", lines: [storedAs] });
  facts.push({
    label: "@constraints",
    lines: constraintBullets(definition).map((bullet) => `- ${bullet}`),
  });

  return facts;
}

/**
 * Lays the labeled facts out with the labels aligned and every continuation
 * line hanging under the first, wrapping the text to the width it was given.
 *
 * @param facts - The facts to render.
 * @param width - The column to wrap at.
 * @returns The rendered lines, colored for a terminal, without indentation.
 */
export function renderFacts(facts: LabeledFact[], width = 100): string[] {
  const labelWidth = Math.max(...facts.map((fact) => fact.label.length)) + 2;
  const textWidth = Math.max(20, width - labelWidth);
  const lines: string[] = [];

  for (const fact of facts) {
    const wrapped = fact.lines.flatMap((line) => wrapText(line, textWidth));
    wrapped.forEach((text, index) => {
      const label = index === 0 ? fact.label.padEnd(labelWidth) : " ".repeat(labelWidth);
      lines.push(`${color.cyan(label)}${text}`);
    });
  }

  return lines;
}
