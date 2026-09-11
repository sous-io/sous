/**
 * Shared display helpers for the `sous vars` commands: masking secrets and
 * laying out the aligned table both the listing and the ask report use.
 */

import { color } from "@oclif/color";
import type { VariableDefinition } from "../repos/formats/recipe-manifest.js";

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
