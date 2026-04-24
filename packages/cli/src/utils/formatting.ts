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
 * Writes the CLI header to the console.
 */
export function header(): void {
  blankLines();
  log(color.cyan(HEADER_LINES.join("\n")));
  log("  Agent Configuration Manager         ");
  blankLine();
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
 */
export function showCommandVars(vars: Record<string, any>): void {
  subheading("Command Variables", "$");
  showVars(vars);
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
 */
export function displayError(text: string): void {
  const lines = text.split("\n");
  log("");
  for (const line of lines) {
    if (line.trim() !== "") {
      log(indent(color.redBright(line.trim())));
    }
  }
  log("");
  log("");
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
 */
export function warning(text: string): void {
  blankLines();
  log(color.bgYellowBright(color.black("   WARNING:   ")));

  const lines = text.split("\n");
  for (const line of lines) {
    if (line.trim() !== "") {
      log(highlightUpperCaseWords(indent(line.trim())));
    }
  }
  blankLine();
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
