/* eslint-disable @typescript-eslint/no-explicit-any */
import { color } from "@oclif/color";

const DEFAULT_VAR_NAME_PADDING = 20;

const HEADER_LINES = [
  "  ▄█████ ▄████▄ ██  ██ ▄█████  ",
  "  ▀▀▀▄▄▄ ██  ██ ██  ██ ▀▀▀▄▄▄  ",
  "  █████▀ ▀████▀ ▀████▀ █████▀  ",
];





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

/**
 * Displays a variable name and its value to the console.
 *
 * @example
 * showVar("Config", "./my-config.js");
 * //   Config              : ./my-config.js
 */
export function showVar(name: string, value: any, padding = DEFAULT_VAR_NAME_PADDING): void {
  const str = `${color.cyan(name.padEnd(padding))}: ${value}`;
  log(indent(str));
}

/**
 * Displays a list of variables to the console, with aligned colons.
 *
 * @example
 * showVars({ Config: "./my-config.js", Strict: "false" });
 * //   Config : ./my-config.js
 * //   Strict : false
 */
export function showVars(vars: Record<string, any>): void {
  const padding = findLongestKeyLength(vars) + 1;
  for (const [name, value] of Object.entries(vars)) {
    showVar(name, value, padding);
  }
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
  showVars(filtered);
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
  const lines = text.split("\n");
  write("");
  for (const line of lines) {
    if (line.trim() !== "") {
      write(indent(color.redBright(line.trim())));
    }
  }
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
  write("");
  for (const line of text.split("\n")) {
    write(line === "" ? " " : indent(color.redBright(line)));
  }
  write("");
  write("");
}

/**
 * Writes a notice indicating that the operation is running in dry-run mode.
 *
 * @example
 * dryRunNotice("File will not be written.");
 * //     [Dry Run] File will not be written.
 */
export function dryRunNotice(text: string): void {
  log("    " + color.cyan("[Dry Run] " + text));
}

/**
 * Writes a warning message to the console with a yellow banner.
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

  const lines = text.split("\n");
  for (const line of lines) {
    if (line.trim() !== "") {
      write(highlightUpperCaseWords(indent(line.trim())));
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
  highlightFn: (word: string) => string = color.yellowBright,
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

/**
 * Finds the length of the longest key in an object.
 */
function findLongestKeyLength(vars: Record<string, any>): number {
  return Math.max(...Object.keys(vars).map(key => key.length));
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
 * Wraps a paragraph to a width, breaking on spaces and never inside a word. A
 * word longer than the width (a URL, a path) is left whole on a line of its
 * own, because half a URL is worse than a long line. Newlines already in the
 * text are honored: each line is wrapped on its own.
 *
 * @param text - The prose to wrap.
 * @param width - The column to wrap at. Defaults to the terminal's width.
 * @returns One string per rendered line, without trailing spaces.
 *
 * @example
 * wrapText("one two three", 7);
 * // -> ["one two", "three"]
 */
export function wrapText(text: string, width: number = terminalColumns()): string[] {
  const limit = Math.max(1, Math.floor(width));
  const lines: string[] = [];

  for (const paragraph of String(text ?? "").split("\n")) {
    const words = paragraph.split(/\s+/).filter(word => word.length > 0);
    if (words.length === 0) {
      lines.push("");
      continue;
    }

    let current = "";
    for (const word of words) {
      if (current.length === 0) current = word;
      else if (current.length + 1 + word.length <= limit) current = `${current} ${word}`;
      else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }

  return lines;
}
