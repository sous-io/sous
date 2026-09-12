/* eslint-disable @typescript-eslint/no-explicit-any */
import { color } from "@oclif/color";

const HEADER_LINES = [
  "  ▄█████ ▄████▄ ██  ██ ▄█████  ",
  "  ▀▀▀▄▄▄ ██  ██ ██  ██ ▀▀▀▄▄▄  ",
  "  █████▀ ▀████▀ ▀████▀ █████▀  ",
];

// --- The Color Palette ---------------------------------------------------------------------------

/**
 * Every color sous writes comes from this one place, so a reader learns the
 * vocabulary once: a label is cyan, the value beside it is bright white, an
 * aside about that value is grey, a warning is bright yellow with its sharpest
 * words in orange, an explanation is bright teal, and an error is bright red.
 *
 * The orange is given as a hex value on purpose. A terminal that can show it
 * does; one limited to sixteen colors has chalk fold it down to bright yellow,
 * which keeps a highlighted word inside the warning's own color rather than
 * turning it into something that reads as a second kind of message.
 */
export const palette = {
  /** The name in a key and value pair. */
  label: (text: string): string => color.cyan(text),
  /** The value beside a label. */
  value: (text: string): string => color.whiteBright(text),
  /** A trailing aside: a location, a provenance, anything secondary. */
  muted: (text: string): string => color.gray(text),
  /** The body of a warning. */
  warning: (text: string): string => color.yellowBright(text),
  /** The words inside a warning that carry the actual risk. */
  highlight: (text: string): string => color.hex("#ff8800")(text),
  /** An explanatory line that is neither a warning nor an error. */
  note: (text: string): string => color.cyanBright(text),
  /** The body of an error. */
  error: (text: string): string => color.redBright(text),
};

/**
 * The prefix every error message carries, so an error is still findable by
 * eye or by grep when the output has no color at all (a pipe, a log file,
 * `CI=true`).
 */
export const ERROR_PREFIX = "Error: ";

/**
 * Adds the error prefix to a message that does not already begin with one, so
 * a message that says "Error:" itself is never made to say it twice.
 *
 * @param text - The first line of an error message.
 */
export function withErrorPrefix(text: string): string {
  return /^error:\s/i.test(text.trimStart()) ? text : `${ERROR_PREFIX}${text}`;
}


// --- Core Output Functions -----------------------------------------------------------------------

/**
 * Writes a string of text to the console, with a newline.
 */
export function log(text: string): void {
  console.log(text);
}

/**
 * Writes a string of text to the console. Concurrent calls to this
 * function will replace the text of the previous call, making this
 * function useful for things like progress indicators.
 */
export function logPersistent(text: string): void {
  process.stdout.write(`\r${text}`);
}

// --- Whitespace Helpers --------------------------------------------------------------------------

/**
 * Writes a blank line to the console.
 * Note that we output a space character to ensure that the line is not
 * completely empty, which some terminal emulators will ignore.
 */
export function blankLine(): void {
  log(" ");
}

/**
 * Writes multiple blank lines to the console.
 */
export function blankLines(blankLineCount = 2): void {
  for (let i = 0; i < blankLineCount; i++) {
    blankLine();
  }
}

// --- String Builders -----------------------------------------------------------------------------

/**
 * Applies a prefix symbol to a string of text. If `prefixSymbol` is
 * an empty string, the text is returned verbatim.
 */
function applyPrefixSymbol(text: string, prefixSymbol = "➔"): string {
  const prefix = prefixSymbol ? `${prefixSymbol} ` : "";
  return `${prefix}${text}`;
}

/**
 * Formats a heading text string. If the heading does not end with a
 * period, a colon is appended.
 */
function formatHeadingText(heading: string): string {
  const append = heading.endsWith(".") ? "" : ":";
  return `${heading}${append}`;
}

/**
 * Indents a block of text by a specified number of spaces.
 */
export function indent(text: string, count = 2, char = " "): string {
  return text
    .split("\n")
    .map(line => char.repeat(count) + line)
    .join("\n");
}

// --- Header & Footer -----------------------------------------------------------------------------

/**
 * Writes the CLI header using the given line writer.
 *
 * Factored out so commands whose stdout must stay machine-readable (the
 * `sous config *` commands, which emit JSON) can route the decorative banner to
 * stderr instead — see ConfigCommand.emitHeader.
 *
 * @param write - Receives one already-formatted line at a time (no trailing newline).
 */
export function headerTo(write: (line: string) => void): void {
  write(" ");
  write(" ");
  write(color.cyan(HEADER_LINES.join("\n")));
  write("  Agent Configuration Manager         ");
  write(" ");
}

/**
 * Writes the CLI header to stdout.
 */
export function header(): void {
  headerTo(log);
}

/**
 * Writes the CLI footer to the console.
 */
export function footer(): void {
  blankLines(2);
}

// --- Headings & Subheadings ----------------------------------------------------------------------

/**
 * Writes a heading to the console.
 *
 * @example
 * heading("Compiling targets");
 * // ▶ Compiling targets:
 */
export function heading(text: string, prefixSymbol = "▶"): void {
  const formatted = formatHeadingText(text);
  const final = applyPrefixSymbol(formatted, prefixSymbol);
  blankLine();
  log(color.yellowBright(final));
}

/**
 * Writes a section heading followed by a blank line, which is how a command
 * opens a section of its output.
 *
 * `heading` on its own leaves the first line of content pressed right up under
 * the heading, which reads as one crowded block. Every command that lays out
 * sections of prose, tables or variable lists uses this instead, so the spacing
 * is decided in one place rather than by a `blankLine()` call remembered at
 * each site.
 *
 * @param text - The heading text; a colon is appended unless it ends in a period.
 * @param prefixSymbol - The marker drawn before the text.
 *
 * @example
 * section("Adding a repository");
 * // ▶ Adding a repository:
 * // (blank line)
 */
export function section(text: string, prefixSymbol = "▶"): void {
  heading(text, prefixSymbol);
  blankLine();
}

/**
 * Writes a subheading to the console.
 *
 * @example
 * subheading("Target 1");
 * // ➔ Target 1:
 */
export function subheading(text: string, prefixSymbol = "➔"): void {
  const formatted = formatHeadingText(text);
  const final = applyPrefixSymbol(formatted, prefixSymbol);
  blankLine();
  log(color.whiteBright(final));
}

// --- Data Display Functions ----------------------------------------------------------------------

/**
 * Dumps the contents of an object to the console.
 */
export function dump<T>(obj: T, headingText?: string): void {
  if (headingText) {
    subheading(headingText);
  }
  const normalized =
    typeof obj === "object" && obj !== null
      ? (sortObjectKeys(obj as Record<string, any>) as T)
      : obj;
  console.dir(normalized);
}

/**
 * Displays a count of something.
 *
 * @example
 * showCount(5, "tokens");
 * // Found [5] tokens
 */
export function showCount(count: number, entity = "items", headingText = "", verb = "Found"): void {
  if (headingText) {
    subheading(headingText);
  }

  const prefix = verb ? `${verb} ` : "";
  let strCount = count.toLocaleString();
  strCount = color.whiteBright(strCount);
  strCount = color.cyan("[") + strCount + color.cyan("]");

  let line = `${prefix}${strCount} ${entity}`;
  if (headingText) {
    line = indent(line);
  }

  log(line);
}

// --- The One Key and Value Display ---------------------------------------------------------------

/**
 * How far a key and value block is indented. Every one of them sits at the same
 * depth, whether it is a command's opening block, a result, or the facts about
 * a variable.
 */
export const VARIABLE_INDENT = 4;

/** One key and value pair, as the display functions take it. */
export interface VariableEntry {
  /**
   * The name, written on the left. An empty label means "the same label as the
   * line above, continued": the label column and its colon are left blank, so a
   * fact that needs several lines still lines up under itself.
   */
  label: string;
  /** The value, written after the colon. Anything printable. */
  value: unknown;
  /**
   * A secondary fact about the value: where it came from, where it lives. It
   * follows the value in muted grey rather than in parentheses, so the value
   * itself stays the thing the eye lands on.
   */
  detail?: string;
}

/** How a key and value block is laid out. */
export interface ShowVariablesOptions {
  /** How far the block is indented. Four by default. */
  indent?: number;
  /**
   * The column the colons line up at, counted from the start of the label.
   * Worked out from the longest label when it is not given, which is what
   * `showVariables` does for a whole block.
   */
  labelWidth?: number;
  /** The column to wrap values at. Defaults to the wrap width. */
  width?: number;
  /** Where the lines go. The console by default. */
  write?: (line: string) => void;
}

/**
 * Lays one key and value pair out: the label in the label color, padded so
 * every colon in the block lines up, then the value in the value color, then
 * any detail in muted grey. A value too long for the line wraps and hangs under
 * the value column rather than under the label.
 *
 * @param entry - The label, the value and any trailing detail.
 * @param options - Indentation, label column and wrap column.
 * @returns The rendered lines.
 */
export function formatVariable(
  entry: VariableEntry,
  options: ShowVariablesOptions = {},
): string[] {
  const pad = " ".repeat(Math.max(0, options.indent ?? VARIABLE_INDENT));
  const labelWidth = Math.max(options.labelWidth ?? entry.label.length, entry.label.length);
  const gutter = labelWidth + 2; // the padded label, then ": "
  const width = options.width ?? wrapColumns();
  const valueWidth = Math.max(20, width - pad.length - gutter);

  const valueText = entry.value === undefined || entry.value === null ? "" : String(entry.value);
  const valueLines = wrapText(valueText, valueWidth, { hangingIndent: 0 });
  const detailLines =
    entry.detail === undefined || entry.detail === ""
      ? []
      : wrapText(entry.detail, valueWidth, { hangingIndent: 0 });

  // The detail joins the value's last line when both fit, and starts a line of
  // its own when they do not, so a long location is never cut in half.
  const cells: string[] = valueLines.map(line => palette.value(line));
  if (detailLines.length > 0) {
    const last = valueLines[valueLines.length - 1] ?? "";
    const [first, ...rest] = detailLines;
    if (last !== "" && displayWidth(last) + 1 + displayWidth(first ?? "") <= valueWidth) {
      cells[cells.length - 1] = `${palette.value(last)} ${palette.muted(first ?? "")}`;
    } else {
      cells.push(palette.muted(first ?? ""));
    }
    for (const line of rest) cells.push(palette.muted(line));
  }

  if (cells.length === 0) cells.push("");

  return cells.map((cell, index) =>
    index === 0 && entry.label !== ""
      ? `${pad}${palette.label(entry.label.padEnd(labelWidth))}: ${cell}`
      : `${pad}${" ".repeat(gutter)}${cell}`,
  );
}

/**
 * Writes one key and value pair to the console.
 *
 * @param label - The name, written on the left.
 * @param value - The value, written after the colon.
 * @param options - Indentation, label column, wrap column and where to write.
 *
 * @example
 * showVariable("Config", "./my-config.js");
 * //     Config: ./my-config.js
 */
export function showVariable(
  label: string,
  value: unknown,
  options: ShowVariablesOptions & { detail?: string } = {},
): void {
  const write = options.write ?? log;
  const entry: VariableEntry = {
    label,
    value,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
  };
  for (const line of formatVariable(entry, options)) write(line);
}

/**
 * Writes a list of key and value pairs to the console, with the colons lined
 * up. Every key and value display in sous goes through this function or through
 * `showVariable`, so there is exactly one of them to change.
 *
 * @param entries - The pairs, either as a plain object or as a list carrying details.
 * @param options - Indentation, wrap column and where to write.
 *
 * @example
 * showVariables({ Config: "./my-config.js", Strict: "false" });
 * //     Config: ./my-config.js
 * //     Strict: false
 */
export function showVariables(
  entries: Record<string, unknown> | VariableEntry[],
  options: ShowVariablesOptions = {},
): void {
  const list: VariableEntry[] = Array.isArray(entries)
    ? entries
    : Object.entries(entries).map(([label, value]) => ({ label, value }));
  if (list.length === 0) return;

  const labelWidth =
    options.labelWidth ?? Math.max(...list.map(entry => entry.label.length));
  for (const entry of list) showVariable(entry.label, entry.value, {
    ...options,
    labelWidth,
    ...(entry.detail === undefined ? {} : { detail: entry.detail }),
  });
}

/**
 * Displays a heading labelled "Command Variables" followed by a variable list.
 *
 * The "Dry Run" entry is a special case: it is noise when dry-run mode is off, so it
 * is only shown when its value is `true`. Every other entry is always shown.
 */
export function showCommandVars(vars: Record<string, any>): void {
  const filtered = Object.fromEntries(
    Object.entries(vars).filter(([name, value]) => name !== "Dry Run" || value === true),
  );
  subheading("Command Variables", "$");
  showVariables(filtered);
}

/**
 * Displays the status of an in-progress scan using an in-place log line.
 */
export function scanStatus(matchedRecordCount: number, totalScanCount: number): void {
  const displayMatched = `[${color.white(matchedRecordCount.toLocaleString())}]`;
  const displayScanned = `[${color.white(totalScanCount.toLocaleString())}]`;
  logPersistent(
    color.gray(
      `Scan in progress: ${displayMatched} records matched (so far) of ${displayScanned} records scanned ...`,
    ),
  );
}

/**
 * Displays the status of an in-progress deletion using an in-place log line.
 */
export function deleteStatus(recordsDeleted: number, totalRecordsToDelete: number): void {
  const displayDeleted = `[${color.white(recordsDeleted.toLocaleString())}]`;
  const displayTotal = `[${color.white(totalRecordsToDelete.toLocaleString())}]`;
  logPersistent(
    color.gray(
      `Deletion in progress: ${displayDeleted} of ${displayTotal} records deleted ...`,
    ),
  );
}

// --- Special Notices -----------------------------------------------------------------------------

/**
 * Writes an error message to the console in red.
 *
 * @param text - The message to display.
 * @param write - Line sink (default stdout via `log`). Commands whose stdout must
 *   stay machine-readable (the `sous config *` JSON commands) pass a stderr writer
 *   so error text never corrupts a piped stdout stream.
 */
export function displayError(text: string, write: (line: string) => void = log): void {
  const lines = text.split("\n").filter(line => line.trim() !== "");
  write("");
  lines.forEach((line, index) => {
    const body = index === 0 ? withErrorPrefix(line.trim()) : line.trim();
    for (const wrapped of wrapText(body, wrapColumns() - 2)) {
      write(indent(palette.error(wrapped)));
    }
  });
  write("");
  write("");
}

/**
 * Writes a pre-formatted, multi-line error message to the console in red,
 * preserving the message's own indentation and blank lines.
 *
 * Use this instead of `displayError` when the message contains deliberate
 * structure (a checked-paths list, a code sample, numbered steps). `displayError`
 * trims every line and drops blanks, which flattens that structure.
 *
 * @param text - The pre-formatted, multi-line message to display.
 * @param write - Line sink (default stdout via `log`). Commands whose stdout must
 *   stay machine-readable (the `sous config *` JSON commands) pass a stderr writer
 *   so error text never corrupts a piped stdout stream.
 *
 * @example
 * displayErrorBlock("No config found.\n\n  Checked:\n    /a/.sous/");
 */
export function displayErrorBlock(text: string, write: (line: string) => void = log): void {
  const lines = text.split("\n");
  // The prefix goes on the first line that has any text on it, which is the
  // line a reader (or a grep) looks at.
  const first = lines.findIndex(line => line.trim() !== "");

  write("");
  lines.forEach((line, index) => {
    if (line === "") {
      write(" ");
      return;
    }
    const body = index === first ? withErrorPrefix(line) : line;
    for (const wrapped of wrapText(body, wrapColumns() - 2)) {
      write(indent(palette.error(wrapped)));
    }
  });
  write("");
  write("");
}

/**
 * Writes a notice indicating that the operation is running in dry-run mode. It
 * is an explanation of what is about to not happen, so it carries the note
 * color rather than the warning one.
 *
 * @example
 * dryRunNotice("File will not be written.");
 * //     [Dry Run] File will not be written.
 */
export function dryRunNotice(text: string): void {
  note(`[Dry Run] ${text}`, { indent: 4 });
}

/**
 * Writes a warning message to the console with a yellow banner. The body is
 * bright yellow; words written in capitals inside it are taken as the ones
 * carrying the risk and are drawn in orange, so a reader skimming the block
 * still takes in the part that matters.
 *
 * @param text - The message to display.
 * @param write - Line sink (default stdout via `log`). Commands whose stdout must
 *   stay machine-readable (the `sous config *` JSON commands) pass a stderr writer
 *   so warning text never corrupts a piped stdout stream.
 */
export function warning(text: string, write: (line: string) => void = log): void {
  write("");
  write("");
  write(color.bgYellowBright(color.black("   WARNING:   ")));

  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      write(" ");
      continue;
    }
    for (const wrapped of wrapText(line.trim(), wrapColumns() - 2)) {
      write(indent(palette.warning(highlightUpperCaseWords(wrapped))));
    }
  }
  write("");
}

// --- Miscellaneous Helpers -----------------------------------------------------------------------

/**
 * Highlights all UPPERCASE words in the given string.
 */
function highlightUpperCaseWords(
  str: string,
  highlightFn: (word: string) => string = palette.highlight,
): string {
  return str.replace(/\b[A-Z][A-Z_'"()\[\]{}<>|&*!@#%^\\-]+\b/g, match => highlightFn(match));
}

/**
 * Sorts the keys of an object alphabetically.
 */
export function sortObjectKeys<T extends Record<string, any>>(obj: T): T {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return obj;
  }

  try {
    return Object.keys(obj)
      .sort()
      .reduce((acc, key) => {
        // @ts-ignore
        acc[key] = obj[key];
        return acc;
      }, {} as T);
  } catch {
    /* c8 ignore next */
    return obj;
  }
}

// --- ANSI-Safe Measurement -----------------------------------------------------------------------

/**
 * Matches the SGR (Select Graphic Rendition) escape sequences the coloring
 * helpers emit, which is every escape sequence sous writes into a string.
 */
const SGR_PATTERN = /\u001B\[[0-9;]*m/g;

/**
 * Removes the color escape sequences from a string, leaving the characters a
 * reader actually sees.
 *
 * @param text - The text to strip.
 * @returns The same text, without any color escape sequence.
 */
export function stripAnsi(text: string): string {
  return String(text ?? "").replace(SGR_PATTERN, "");
}

/**
 * How many terminal columns a string occupies once its color codes are taken
 * out. Every alignment decision measures with this, because a colored cell is
 * longer than it looks.
 *
 * East Asian wide characters and emoji are out of scope: this counts one column
 * per code unit, so a cell holding them aligns a little short. Everything sous
 * lays out in a table is an identifier, a path, a URL or English prose, so the
 * simple measure holds; widening it later means changing this one function.
 *
 * @param text - The text to measure.
 * @returns The visible width, in columns.
 */
export function displayWidth(text: string): number {
  return stripAnsi(text).length;
}

// --- Width-Aware Wrapping ------------------------------------------------------------------------

/**
 * The width sous wraps prose to when the output is not a terminal, or when the
 * terminal never said how wide it is.
 */
export const DEFAULT_WRAP_COLUMNS = 100;

/**
 * How many columns the output has to work with: the real terminal width when
 * there is a terminal, and the default width otherwise, so a piped or recorded
 * run always wraps the same way.
 *
 * @param stream - The stream to measure. Defaults to stdout.
 */
export function terminalColumns(stream: { columns?: number } = process.stdout): number {
  const columns = stream.columns;
  return typeof columns === "number" && columns > 0 ? columns : DEFAULT_WRAP_COLUMNS;
}

/**
 * How far short of the right edge text stops, so a wrapped paragraph never
 * touches the last column of the terminal.
 */
export const RIGHT_MARGIN = 2;

/**
 * The width every paragraph sous prints is wrapped to: the columns available,
 * less the right margin.
 *
 * @param stream - The stream to measure. Defaults to stdout.
 */
export function wrapColumns(stream: { columns?: number } = process.stdout): number {
  return Math.max(20, terminalColumns(stream) - RIGHT_MARGIN);
}

/** How a paragraph is wrapped. */
export interface WrapOptions {
  /**
   * How far a continuation line hangs past the first line of its paragraph.
   * Two by default, which is what makes a wrapped sentence read as one
   * paragraph rather than as several. Pass zero where the caller lays out its
   * own hanging indent, as the labeled blocks do.
   */
  hangingIndent?: number;
}

/**
 * Wraps a paragraph to a width, breaking on spaces and never inside a word. A
 * word longer than the width (a URL, a path) is left whole on a line of its
 * own, because half a URL is worse than a long line.
 *
 * Newlines already in the text are honored: each line is wrapped on its own,
 * and each keeps whatever indentation it was written with, so an already laid
 * out block survives being passed through. Continuation lines hang two spaces
 * past the line they continue, unless the caller asks for something else.
 *
 * Width is measured with the color codes taken out, so a colored word is
 * counted by what a reader sees rather than by what the escape sequences add.
 *
 * @param text - The prose to wrap.
 * @param width - The column to wrap at. Defaults to the terminal width, less the right margin.
 * @param options - How far continuation lines hang.
 * @returns One string per rendered line, without trailing spaces.
 *
 * @example
 * wrapText("one two three", 7, { hangingIndent: 0 });
 * // -> ["one two", "three"]
 */
export function wrapText(
  text: string,
  width: number = wrapColumns(),
  options: WrapOptions = {},
): string[] {
  const limit = Math.max(1, Math.floor(width));
  const hanging = Math.max(0, Math.floor(options.hangingIndent ?? 2));
  const lines: string[] = [];

  for (const paragraph of String(text ?? "").split("\n")) {
    // The line's own indentation is kept, and continuation lines are measured
    // and drawn from inside it, so a block that arrives already laid out is
    // still laid out when it leaves.
    const leading = /^[ \t]*/.exec(paragraph)?.[0] ?? "";
    const body = paragraph.slice(leading.length);
    const words = body.split(/\s+/).filter(word => word.length > 0);
    if (words.length === 0) {
      lines.push("");
      continue;
    }

    const continuation = leading + " ".repeat(hanging);
    let prefix = leading;
    let current = "";

    for (const word of words) {
      if (current.length === 0) {
        current = word;
        continue;
      }
      const projected = displayWidth(prefix) + displayWidth(current) + 1 + displayWidth(word);
      if (projected <= limit) {
        current = `${current} ${word}`;
        continue;
      }
      lines.push(`${prefix}${current}`);
      prefix = continuation;
      current = word;
    }

    lines.push(`${prefix}${current}`);
  }

  return lines;
}

/** How a paragraph is laid out for printing. */
export interface ParagraphOptions extends WrapOptions {
  /** How far the whole paragraph is indented. Two by default. */
  indent?: number;
  /** The column to wrap at, indentation included. Defaults to the wrap width. */
  width?: number;
  /** A color to paint every line with. */
  color?: (text: string) => string;
}

/**
 * Lays a paragraph out for printing: wrapped to the width left after its own
 * indentation, indented, and colored.
 *
 * @param text - The prose to lay out.
 * @param options - Indentation, wrap column and color.
 * @returns The rendered lines.
 */
export function formatParagraph(text: string, options: ParagraphOptions = {}): string[] {
  const pad = Math.max(0, options.indent ?? 2);
  const width = options.width ?? wrapColumns();
  const wrapOptions: WrapOptions =
    options.hangingIndent === undefined ? {} : { hangingIndent: options.hangingIndent };
  const paint = options.color ?? ((line: string) => line);

  return wrapText(text, Math.max(20, width - pad), wrapOptions).map(line =>
    line === "" ? " " : " ".repeat(pad) + paint(line),
  );
}

/**
 * Writes a wrapped, indented paragraph to the console. Every long sentence the
 * CLI prints goes through this, so nothing is ever left to the terminal's own
 * idea of where a line should break.
 *
 * @param text - The prose to print.
 * @param options - Indentation, wrap column and color.
 */
export function paragraph(text: string, options: ParagraphOptions = {}): void {
  for (const line of formatParagraph(text, options)) log(line);
}

/**
 * Writes an explanatory line: something that is neither a warning nor an error,
 * but a note about what just happened or what is about to. It is bright teal,
 * which is the one color reserved for explanation.
 *
 * @param text - The note to print.
 * @param options - Indentation and wrap column.
 */
export function note(text: string, options: Omit<ParagraphOptions, "color"> = {}): void {
  paragraph(text, { ...options, color: palette.note });
}

// --- Key Bindings --------------------------------------------------------------------------------

/**
 * The one-line legend a prompt draws under itself, in the style the stock
 * `@inquirer/select` prompt uses: the key in bold, what it does dimmed beside
 * it, pairs separated by a dimmed bullet.
 *
 * @param keys - Key and action pairs, in the order they are shown.
 * @returns The legend line.
 *
 * @example
 * keysHelpTip([["↑↓", "navigate"], ["⏎", "select"]]);
 * // -> "↑↓ navigate • ⏎ select"
 */
export function keysHelpTip(keys: Array<[key: string, action: string]>): string {
  return keys
    .map(([key, action]) => `${color.bold(key)} ${color.dim(action)}`)
    .join(color.dim(" • "));
}

/**
 * The character every bulleted line in the CLI is drawn with, so a list of
 * points always looks like a list of points.
 */
export const BULLET = "•";

/** How many blank lines a question keeps under itself while it is waiting. */
export const PROMPT_BOTTOM_PADDING = 2;

/**
 * The block a prompt draws under its input line: whatever it has to say
 * (a validation message, the key legend), then two blank lines, so a question
 * never sits on the terminal's very last row with its legend scrolled away.
 *
 * @param content - The line under the prompt, or an empty string for none.
 * @returns The bottom block, ready to hand back from a prompt's renderer.
 */
export function promptBottom(content: string): string {
  const lines = content === "" ? [] : [content];
  for (let index = 0; index < PROMPT_BOTTOM_PADDING; index++) lines.push(" ");
  return lines.join("\n");
}
