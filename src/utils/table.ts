/**
 * The responsive table renderer every sous listing prints through.
 *
 * A caller describes its columns once (what they hold, which ones matter, which
 * one may soak up leftover room) and the renderer fits them to the terminal it
 * actually has: columns shrink toward their minimums, long cells wrap or are
 * truncated on the side that keeps the useful half, and the least important
 * columns step aside entirely when the window is too narrow to hold everything.
 *
 * The rendered lines come back without indentation, so a caller that indents its
 * output keeps doing that itself; tell the renderer how far it indents with the
 * `indent` option so the indentation comes out of the width budget.
 */

import { color } from "@oclif/color";
import {
  DEFAULT_WRAP_COLUMNS,
  displayWidth,
  terminalColumns,
  wrapText,
} from "./formatting.js";

/** What a column holds, which decides how it aligns and where it truncates. */
export type ColumnKind = "text" | "path" | "url" | "number";

/** What a column does with a cell too long for it. */
export type ColumnOverflow = "wrap" | "truncate";

/** Which end of a cell is given up when it is truncated. */
export type TruncateSide = "start" | "middle" | "end";

/** Where a cell sits inside its column. */
export type ColumnAlign = "left" | "right" | "center";

/** How willingly a column is hidden when the terminal is too narrow. */
export type ColumnPriority = "low" | "medium" | "high";

/** One column of a table. */
export interface TableColumn {
  /** The property each row is read from. */
  key: string;
  /** The heading shown above the column. */
  header: string;
  /** Whether a long cell wraps onto more lines or is cut. Defaults to wrapping. */
  overflow?: ColumnOverflow;
  /** Which end a cut takes from. Defaults by kind: the middle of a path or a URL, the end of anything else. */
  truncate?: TruncateSide;
  /** What the column holds. Defaults to plain text. */
  kind?: ColumnKind;
  /** Where a cell sits in the column. Defaults to the right for a number, the left for everything else. */
  align?: ColumnAlign;
  /** This column's share of any width left over once every column has its natural width. Defaults to none. */
  flex?: number;
  /** The narrowest this column is ever squeezed to. Defaults to the width of its heading. */
  minWidth?: number;
  /** How willingly the column is hidden. A high column is never hidden; a low one goes first. Defaults to high. */
  priority?: ColumnPriority;
}

/** Everything about a table that is not a column. */
export interface TableOptions<Row extends Record<string, unknown>> {
  /**
   * The number of columns to lay the table out in. Defaults to the terminal's
   * width. Passing a width also allows columns to be hidden, because a caller
   * that names a width is describing a window it knows the size of.
   */
  width?: number;
  /** How far the caller indents the table, taken out of the width budget. Defaults to none. */
  indent?: number;
  /** The spaces left between two columns. Defaults to two. */
  gap?: number;
  /** Whether to print the heading row and the rule under it. Defaults to true. */
  header?: boolean;
  /** The stream the width is read from. Defaults to stdout. */
  stream?: { columns?: number; isTTY?: boolean };
  /**
   * An extra line printed under a row, already colored by the caller; return
   * nothing to print none. This is how a command shows a detail that does not
   * deserve a column of its own.
   */
  rowNote?: (row: Row, index: number) => string | undefined;
}

/** The color escape sequences sous emits, as a source string the cell slicer reuses. */
const SGR_SOURCE = "\\u001B\\[[0-9;]*m";

/** The sequence that puts the terminal back to its plain colors. */
const RESET = "\u001B[0m";

/** How much of a column a cut takes out. */
const ELLIPSIS = "…";

/** Which priority yields first when a column has to go. */
const PRIORITY_RANK: Record<ColumnPriority, number> = { low: 0, medium: 1, high: 2 };

/**
 * Lays a table out to fit the width it was given and returns the lines to
 * print, colored for a terminal and without indentation or trailing spaces.
 *
 * @param columns - The columns, in the order they are shown.
 * @param rows - One object per row; each column reads the property named by its key.
 * @param options - The width to fit, the gap, and whether to show the heading.
 * @returns The rendered lines, plus a closing note when columns had to be hidden.
 *
 * @example
 * renderTable([{ key: "name", header: "Name" }], [{ name: "workflow" }]);
 * // -> ["Name", "----", "workflow"]
 */
export function renderTable<Row extends Record<string, unknown>>(
  columns: TableColumn[],
  rows: Row[],
  options: TableOptions<Row> = {}
): string[] {
  if (columns.length === 0) return [];

  const gap = options.gap ?? 2;
  const indentWidth = options.indent ?? 0;
  const showHeader = options.header ?? true;
  const stream = options.stream ?? process.stdout;

  // A width the caller named describes a window of known size, so columns may be
  // hidden to fit it. Without one, only a real terminal is measured; piped and
  // recorded output always gets the full table at the default width, so a script
  // reading it never loses a column to the size of somebody's window.
  const measured =
    options.width ?? (stream.isTTY === true ? terminalColumns(stream) : DEFAULT_WRAP_COLUMNS);
  const mayHide = options.width !== undefined || stream.isTTY === true;
  const budget = Math.max(1, Math.floor(measured) - indentWidth);

  const { widths, visible, hidden } = fitColumns(columns, rows, {
    budget,
    gap,
    showHeader,
    mayHide,
  });

  const lines: string[] = [];

  if (showHeader) {
    const headers = visible.map((column, index) =>
      padTo(truncateToWidth(column.header, widths[index]!, "end"), widths[index]!, alignOf(column))
    );
    lines.push(color.cyan(joinCells(headers, gap)));
    lines.push(
      color.gray(joinCells(widths.map((width) => "-".repeat(width)), gap))
    );
  }

  rows.forEach((row, rowIndex) => {
    for (const line of renderRow(row, visible, widths, gap)) lines.push(line);
    const note = options.rowNote?.(row, rowIndex);
    if (note !== undefined && note !== "") lines.push(note);
  });

  if (hidden.length > 0) {
    const names = hidden.map((column) => column.header).join(", ");
    lines.push(
      `Hidden at this width: ${names}. Widen the terminal to see ` +
        `${hidden.length === 1 ? "it" : "them"}.`
    );
  }

  return lines;
}

// --- Laying the columns out ----------------------------------------------------------------------

/** What the fitting pass needs to know about the window it is fitting to. */
interface FitInput {
  budget: number;
  gap: number;
  showHeader: boolean;
  mayHide: boolean;
}

/** The outcome of the fitting pass: what is shown, how wide, and what was left out. */
interface FitResult {
  widths: number[];
  visible: TableColumn[];
  hidden: TableColumn[];
}

/**
 * Decides how wide every column is, and which columns do not fit at all.
 *
 * Each column starts at its natural width (the widest cell it holds, and its
 * heading when one is shown). If the total is too wide, the least important
 * columns give width back first, in proportion to how far each sits above its
 * own minimum, and the more important ones only once those run out. If the minimums
 * alone still do not fit, the least important column is hidden and the whole
 * pass runs again. When nothing may be hidden and the minimums still do not fit,
 * every column is squeezed toward a single character rather than letting the
 * table run off the edge of the window.
 *
 * @param columns - Every column the caller asked for.
 * @param rows - The rows, measured to find each column's natural width.
 * @param input - The width budget, the gap, and whether columns may be hidden.
 */
function fitColumns<Row extends Record<string, unknown>>(
  columns: TableColumn[],
  rows: Row[],
  input: FitInput
): FitResult {
  let visible = [...columns];

  for (;;) {
    const floors = visible.map((column) => minimumWidth(column, input.showHeader));
    const targets = visible.map((column, index) =>
      Math.max(naturalWidth(column, rows, input.showHeader), floors[index]!)
    );
    const flexes = visible.map((column) => Math.max(0, column.flex ?? 0));
    const ranks = visible.map((column) => PRIORITY_RANK[column.priority ?? "high"]);
    const cellBudget = Math.max(
      visible.length,
      input.budget - input.gap * (visible.length - 1)
    );

    const fitted = distribute(targets, floors, flexes, ranks, cellBudget);
    if (fitted.shortBy === 0) {
      return {
        widths: fitted.widths,
        visible,
        hidden: columns.filter((column) => !visible.includes(column)),
      };
    }

    const victim = hideableColumn(visible);
    if (!input.mayHide || victim === undefined) {
      // Nothing may step aside, so everything is squeezed instead: a cramped
      // table still reads, a table wider than the window does not.
      const squeezed = distribute(
        targets,
        targets.map(() => 1),
        flexes,
        ranks,
        cellBudget
      );
      return {
        widths: squeezed.widths,
        visible,
        hidden: columns.filter((column) => !visible.includes(column)),
      };
    }

    visible = visible.filter((column) => column !== victim);
    if (visible.length === 0) return { widths: [], visible, hidden: columns };
  }
}

/**
 * Shares the width budget out among the columns: slack goes to the columns that
 * asked to flex, and a shortfall is taken from the columns that matter least
 * first, spread among them in proportion to how far each sits above its own
 * floor. A high column only gives width up once every less important column has
 * given all of its own, which is what keeps an identifier from being cut in
 * half while a sentence beside it keeps its full width.
 *
 * @param targets - The width each column would like, its minimum included.
 * @param floors - The narrowest each column may become.
 * @param flexes - Each column's share of any leftover width.
 * @param ranks - Each column's importance, lowest first.
 * @param budget - The columns' share of the window, gaps already taken out.
 * @returns The widths, and how much width could not be found (zero when it fit).
 */
function distribute(
  targets: number[],
  floors: number[],
  flexes: number[],
  ranks: number[],
  budget: number
): { widths: number[]; shortBy: number } {
  const widths = [...targets];
  const total = sum(widths);

  if (total <= budget) {
    grow(widths, flexes, budget - total);
    return { widths, shortBy: 0 };
  }

  let deficit = total - budget;

  for (const band of [PRIORITY_RANK.low, PRIORITY_RANK.medium, PRIORITY_RANK.high]) {
    if (deficit <= 0) break;
    const members: number[] = [];
    ranks.forEach((rank, index) => {
      if (rank === band) members.push(index);
    });
    deficit -= takeFrom(widths, floors, members, deficit);
  }

  return { widths, shortBy: Math.max(0, deficit) };
}

/**
 * Takes width off one band of columns, spread in proportion to how much room
 * each has above its floor, and never below that floor.
 *
 * @param widths - The widths so far, changed in place.
 * @param floors - The narrowest each column may become.
 * @param members - Which columns this band holds.
 * @param wanted - How much width to find.
 * @returns How much was actually found.
 */
function takeFrom(
  widths: number[],
  floors: number[],
  members: number[],
  wanted: number
): number {
  const room = members.map((index) => widths[index]! - floors[index]!);
  const totalRoom = sum(room);
  if (totalRoom <= 0 || wanted <= 0) return 0;

  const target = Math.min(wanted, totalRoom);
  let taken = 0;

  members.forEach((index, slot) => {
    const cut = Math.min(room[slot]!, Math.floor((target * room[slot]!) / totalRoom));
    widths[index] = widths[index]! - cut;
    taken += cut;
  });

  // Rounding always leaves a little to find; take it one column at a time from
  // whichever still has the most room above its floor.
  while (taken < target) {
    let best = -1;
    let bestRoom = 0;
    for (const index of members) {
      const left = widths[index]! - floors[index]!;
      if (left >= bestRoom && left > 0) {
        best = index;
        bestRoom = left;
      }
    }
    if (best < 0) break;
    widths[best] = widths[best]! - 1;
    taken += 1;
  }

  return taken;
}

/**
 * Hands leftover width to the columns that asked to flex, largest share first.
 *
 * @param widths - The widths so far, changed in place.
 * @param flexes - Each column's share.
 * @param slack - The width left to give away.
 */
function grow(widths: number[], flexes: number[], slack: number): void {
  const totalFlex = sum(flexes);
  if (slack <= 0 || totalFlex <= 0) return;

  let given = 0;
  for (let index = 0; index < widths.length; index += 1) {
    const share = Math.floor((slack * flexes[index]!) / totalFlex);
    widths[index] = widths[index]! + share;
    given += share;
  }

  let rest = slack - given;
  for (let index = 0; index < widths.length && rest > 0; index += 1) {
    if (flexes[index]! <= 0) continue;
    widths[index] = widths[index]! + 1;
    rest -= 1;
  }
}

/**
 * The column that steps aside first: the least important one, and the rightmost
 * of those when several share the same importance. A column of high importance
 * is never hidden.
 *
 * @param columns - The columns still being shown.
 * @returns The column to hide, or undefined when every one of them must stay.
 */
function hideableColumn(columns: TableColumn[]): TableColumn | undefined {
  let victim: TableColumn | undefined;
  let victimRank = Number.POSITIVE_INFINITY;

  for (const column of columns) {
    const rank = PRIORITY_RANK[column.priority ?? "high"];
    if (rank >= PRIORITY_RANK.high) continue;
    if (rank <= victimRank) {
      victim = column;
      victimRank = rank;
    }
  }

  return victim;
}

/**
 * How wide a column would like to be: its widest cell, and its heading when the
 * table shows one.
 *
 * @param column - The column to measure.
 * @param rows - Every row the table will print.
 * @param showHeader - Whether the heading row counts toward the width.
 */
function naturalWidth<Row extends Record<string, unknown>>(
  column: TableColumn,
  rows: Row[],
  showHeader: boolean
): number {
  let widest = showHeader ? displayWidth(column.header) : 0;
  for (const row of rows) widest = Math.max(widest, displayWidth(cellText(row, column)));
  return Math.max(1, widest);
}

/**
 * The narrowest a column may be squeezed to: what it asked for, or the width of
 * its heading when it asked for nothing and a heading is shown.
 *
 * @param column - The column to measure.
 * @param showHeader - Whether the heading row is being printed.
 */
function minimumWidth(column: TableColumn, showHeader: boolean): number {
  if (column.minWidth !== undefined) return Math.max(1, column.minWidth);
  return showHeader ? Math.max(1, displayWidth(column.header)) : 1;
}

/** The text one row shows in one column. */
function cellText<Row extends Record<string, unknown>>(row: Row, column: TableColumn): string {
  const value = row[column.key];
  return value === undefined || value === null ? "" : String(value);
}

/** Where a column's cells sit, taking the kind's default when nothing was said. */
function alignOf(column: TableColumn): ColumnAlign {
  if (column.align !== undefined) return column.align;
  return column.kind === "number" ? "right" : "left";
}

/** Which end a column gives up when it is cut, taking the kind's default. */
function truncateSideOf(column: TableColumn): TruncateSide {
  if (column.truncate !== undefined) return column.truncate;
  return column.kind === "path" || column.kind === "url" ? "middle" : "end";
}

// --- Rendering -----------------------------------------------------------------------------------

/**
 * Renders one row, which is as tall as its tallest wrapped cell; every other
 * cell in the row is padded with blank lines under it.
 *
 * @param row - The row to render.
 * @param columns - The columns being shown.
 * @param widths - The width decided for each of them.
 * @param gap - The spaces between two columns.
 */
function renderRow<Row extends Record<string, unknown>>(
  row: Row,
  columns: TableColumn[],
  widths: number[],
  gap: number
): string[] {
  const cells = columns.map((column, index) => {
    const width = widths[index]!;
    const text = cellText(row, column);
    return (column.overflow ?? "wrap") === "wrap"
      ? wrapCell(text, width)
      : [truncateToWidth(text, width, truncateSideOf(column))];
  });

  const height = Math.max(1, ...cells.map((lines) => lines.length));
  const rendered: string[] = [];

  for (let line = 0; line < height; line += 1) {
    rendered.push(
      joinCells(
        columns.map((column, index) =>
          padTo(cells[index]![line] ?? "", widths[index]!, alignOf(column))
        ),
        gap
      )
    );
  }

  return rendered;
}

/** Joins already-padded cells with the gap, leaving no trailing spaces behind. */
function joinCells(cells: string[], gap: number): string {
  return cells.join(" ".repeat(gap)).trimEnd();
}

/**
 * Wraps a cell to its column, breaking on spaces where it can and inside a word
 * when the word alone is wider than the column.
 *
 * @param text - The cell's text.
 * @param width - The column's width.
 */
function wrapCell(text: string, width: number): string[] {
  const lines: string[] = [];
  // A table cell hangs nothing: the column itself is the indentation, so a
  // wrapped cell starts at the column's own left edge.
  for (const line of wrapText(text, width, { hangingIndent: 0 })) {
    if (displayWidth(line) <= width) {
      lines.push(line);
      continue;
    }
    for (let start = 0; start < displayWidth(line); start += width) {
      lines.push(sliceVisible(line, start, start + width));
    }
  }
  return lines;
}

/**
 * Cuts a cell down to a width, marking the cut with a single character so the
 * reader can see that something was left out.
 *
 * @param text - The cell's text.
 * @param width - The width to fit into.
 * @param side - Which end of the text to give up.
 */
function truncateToWidth(text: string, width: number, side: TruncateSide): string {
  const visible = displayWidth(text);
  if (visible <= width) return text;
  if (width <= 1) return ELLIPSIS.slice(0, Math.max(0, width));

  if (side === "start") return `${ELLIPSIS}${sliceVisible(text, visible - (width - 1), visible)}`;
  if (side === "end") return `${sliceVisible(text, 0, width - 1)}${ELLIPSIS}`;

  const head = Math.ceil((width - 1) / 2);
  const tail = width - 1 - head;
  return `${sliceVisible(text, 0, head)}${ELLIPSIS}${sliceVisible(text, visible - tail, visible)}`;
}

/**
 * Pads a cell out to its column's width, in the direction the column aligns.
 *
 * @param text - The cell's text, already short enough for the column.
 * @param width - The column's width.
 * @param align - Where the text sits.
 */
function padTo(text: string, width: number, align: ColumnAlign): string {
  const room = width - displayWidth(text);
  if (room <= 0) return text;
  if (align === "right") return `${" ".repeat(room)}${text}`;
  if (align === "center") {
    const left = Math.floor(room / 2);
    return `${" ".repeat(left)}${text}${" ".repeat(room - left)}`;
  }
  return `${text}${" ".repeat(room)}`;
}

/**
 * Takes the visible characters between two columns of a string, carrying every
 * color code along so a cut never leaves the terminal stuck in a color.
 *
 * @param text - The text to cut.
 * @param start - The first visible column to keep.
 * @param end - The column to stop before.
 */
function sliceVisible(text: string, start: number, end: number): string {
  const pattern = new RegExp(SGR_SOURCE, "g");
  let out = "";
  let visible = 0;
  let cursor = 0;
  let colored = false;

  for (const match of text.matchAll(pattern)) {
    const plain = text.slice(cursor, match.index);
    const taken = takeVisible(plain, visible, start, end);
    out += taken.text;
    visible += plain.length;
    out += match[0];
    colored = true;
    cursor = match.index + match[0].length;
  }

  const rest = text.slice(cursor);
  out += takeVisible(rest, visible, start, end).text;

  return colored ? `${out}${RESET}` : out;
}

/**
 * The part of one uncolored run that falls inside the wanted columns.
 *
 * @param plain - The run of characters, with no color codes in it.
 * @param offset - How many visible characters came before this run.
 * @param start - The first visible column wanted.
 * @param end - The column to stop before.
 */
function takeVisible(
  plain: string,
  offset: number,
  start: number,
  end: number
): { text: string } {
  const from = Math.max(0, start - offset);
  const to = Math.min(plain.length, end - offset);
  return { text: from >= to ? "" : plain.slice(from, to) };
}

/** Adds a list of numbers up. */
function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
