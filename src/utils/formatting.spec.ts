import { describe, it, expect, vi } from "vitest";
import {
  indent,
  sortObjectKeys,
  blankLine,
  blankLines,
  header,
  footer,
  dump,
  heading,
  section,
  subheading,
  showVariable,
  showVariables,
  formatVariable,
  withErrorPrefix,
  keysHelpTip,
  showCount,
  showCommandVars,
  scanStatus,
  deleteStatus,
  displayError,
  dryRunNotice,
  warning,
  wrapText,
  terminalColumns,
  DEFAULT_WRAP_COLUMNS,
} from "./formatting.js";

// Strip ANSI escape codes so we can assert on plain text
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Collect all console.log calls as plain-text lines
function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
    lines.push(strip(args.join(" ")));
  });
  fn();
  spy.mockRestore();
  return lines;
}

// Collect process.stdout.write calls as plain-text strings
function captureStdout(fn: () => void): string[] {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    chunks.push(strip(String(chunk)));
    return true;
  });
  fn();
  spy.mockRestore();
  return chunks;
}

// ---- indent ---------------------------------------------------------------------------------

describe("indent()", () => {
  /**
   * indent() should prefix each line of a string with spaces.
   * By default, it uses 2 spaces.
   *
   * indent("hello");
   * // -> "  hello"
   */
  it("should indent a single line by 2 spaces by default", () => {
    expect(indent("hello")).toBe("  hello");
  });

  /**
   * indent() should apply the indent to every line in a multi-line string,
   * not just the first.
   *
   * indent("foo\nbar\nbaz");
   * // -> "  foo\n  bar\n  baz"
   */
  it("should indent each line of a multi-line string", () => {
    expect(indent("foo\nbar\nbaz")).toBe("  foo\n  bar\n  baz");
  });

  /**
   * indent() should accept a custom indent count and use that many spaces.
   *
   * indent("hello", 4);
   * // -> "    hello"
   */
  it("should respect a custom indent count", () => {
    expect(indent("hello", 4)).toBe("    hello");
  });

  /**
   * indent() should accept a custom indent character and repeat it `count` times.
   *
   * indent("hello", 2, "\t");
   * // -> "\t\thello"
   */
  it("should respect a custom indent character", () => {
    expect(indent("hello", 2, "\t")).toBe("\t\thello");
  });

  /**
   * indent() should handle an empty string by returning just the indent prefix.
   *
   * indent("");
   * // -> "  "
   */
  it("should handle an empty string", () => {
    expect(indent("")).toBe("  ");
  });
});

// ---- sortObjectKeys -------------------------------------------------------------------------

describe("sortObjectKeys()", () => {
  /**
   * sortObjectKeys() should accept an input object with keys in any order
   * and return a _new_ object with the same keys sorted alphabetically.
   *
   * sortObjectKeys({ zebra: 1, apple: 2, mango: 3 });
   * // -> { apple: 2, mango: 3, zebra: 1 }
   */
  it("should return a new object with keys in alphabetical order", () => {
    const result = sortObjectKeys({ zebra: 1, apple: 2, mango: 3 });
    expect(Object.keys(result)).toEqual(["apple", "mango", "zebra"]);
  });

  /**
   * sortObjectKeys() should preserve all values when reordering keys.
   *
   * sortObjectKeys({ b: "second", a: "first" });
   * // -> { a: "first", b: "second" }
   */
  it("should preserve values when sorting keys", () => {
    const result = sortObjectKeys({ b: "second", a: "first" });
    expect(result).toEqual({ a: "first", b: "second" });
  });

  /**
   * sortObjectKeys() should return null as-is without throwing,
   * since null is not a sortable object.
   *
   * sortObjectKeys(null);
   * // -> null
   */
  it("should return null as-is", () => {
    expect(sortObjectKeys(null as any)).toBeNull();
  });

  /**
   * sortObjectKeys() should return an array as-is without sorting its contents,
   * since arrays are not plain objects.
   *
   * const arr = [3, 1, 2];
   * sortObjectKeys(arr); // -> [3, 1, 2] (same reference)
   */
  it("should return an array as-is", () => {
    const arr = [3, 1, 2];
    expect(sortObjectKeys(arr as any)).toBe(arr);
  });

  /**
   * sortObjectKeys() should return non-object primitives as-is.
   *
   * sortObjectKeys("string");
   * // -> "string"
   */
  it("should return a non-object primitive as-is", () => {
    expect(sortObjectKeys("string" as any)).toBe("string");
  });

  /**
   * sortObjectKeys() should handle an empty object without throwing.
   *
   * sortObjectKeys({});
   * // -> {}
   */
  it("should return an empty object unchanged", () => {
    expect(sortObjectKeys({})).toEqual({});
  });

  /**
   * sortObjectKeys() should only sort top-level keys; nested object keys
   * are left in their original order.
   *
   * sortObjectKeys({ a: { z: 1, a: 2 } });
   * // -> { a: { z: 1, a: 2 } }  (nested keys not reordered)
   */
  it("should not recursively sort nested objects", () => {
    const input = { a: { z: 1, a: 2 } };
    const result = sortObjectKeys(input);
    expect(Object.keys(result)).toEqual(["a"]);
    expect(Object.keys(result.a)).toEqual(["z", "a"]);
  });
});

// ---- blankLine ------------------------------------------------------------------------------

describe("blankLine()", () => {
  /**
   * blankLine() should write exactly one line to the console.
   *
   * blankLine();
   * // logs 1 line
   */
  it("should log a single line to the console", () => {
    const lines = captureLog(() => blankLine());
    expect(lines).toHaveLength(1);
  });
});

// ---- blankLines -----------------------------------------------------------------------------

describe("blankLines()", () => {
  /**
   * blankLines() should default to writing 2 blank lines when called
   * without arguments.
   *
   * blankLines();
   * // logs 2 lines
   */
  it("should log 2 lines by default", () => {
    const lines = captureLog(() => blankLines());
    expect(lines).toHaveLength(2);
  });

  /**
   * blankLines() should write exactly as many lines as requested.
   *
   * blankLines(4);
   * // logs 4 lines
   */
  it("should log the requested number of lines", () => {
    const lines = captureLog(() => blankLines(4));
    expect(lines).toHaveLength(4);
  });
});

// ---- heading --------------------------------------------------------------------------------

describe("heading()", () => {
  /**
   * heading() should include the provided text somewhere in its console output.
   *
   * heading("Compiling targets");
   * // output contains "Compiling targets"
   */
  it("should include the heading text in output", () => {
    const lines = captureLog(() => heading("Compiling targets"));
    expect(lines.join("\n")).toContain("Compiling targets");
  });

  /**
   * heading() should append a colon to the text when it does not already
   * end with a period.
   *
   * heading("Building");
   * // output contains "Building:"
   */
  it("should append a colon when the text does not end with a period", () => {
    const lines = captureLog(() => heading("Building"));
    expect(lines.join("\n")).toContain("Building:");
  });

  /**
   * heading() should not append a colon when the text already ends with
   * a period, to avoid "Done.:" style double-punctuation.
   *
   * heading("Done.");
   * // output contains "Done." but not "Done.:"
   */
  it("should not double-punctuate when text ends with a period", () => {
    const joined = captureLog(() => heading("Done.")).join("\n");
    expect(joined).toContain("Done.");
    expect(joined).not.toContain("Done.:");
  });

  /**
   * heading() should include the prefix symbol in its output.
   *
   * heading("Test", "▶");
   * // output contains "▶"
   */
  it("should include the prefix symbol", () => {
    const lines = captureLog(() => heading("Test", "▶"));
    expect(lines.join("\n")).toContain("▶");
  });
});

// ---- section --------------------------------------------------------------------------------

describe("section()", () => {
  /**
   * section() should write the same heading line heading() does, so switching a
   * command over to it changes the spacing and nothing else.
   *
   * section("Adding a repository");
   * // output contains "▶ Adding a repository:"
   */
  it("should write the heading line", () => {
    const joined = captureLog(() => section("Adding a repository")).join("\n");
    expect(joined).toContain("▶");
    expect(joined).toContain("Adding a repository:");
  });

  /**
   * section() should leave a blank line under the heading, which is the whole
   * point of it: the content below a heading never sits pressed against it.
   *
   * section("Adding a repository");
   * // last line is blank
   */
  it("should leave a blank line under the heading", () => {
    const headingLines = captureLog(() => heading("Adding a repository"));
    const sectionLines = captureLog(() => section("Adding a repository"));

    expect(sectionLines).toHaveLength(headingLines.length + 1);
    expect(sectionLines.at(-1)?.trim()).toBe("");
  });
});

// ---- subheading -----------------------------------------------------------------------------

describe("subheading()", () => {
  /**
   * subheading() should include the provided text somewhere in its console output.
   *
   * subheading("Target 1");
   * // output contains "Target 1"
   */
  it("should include the subheading text in output", () => {
    const lines = captureLog(() => subheading("Target 1"));
    expect(lines.join("\n")).toContain("Target 1");
  });

  /**
   * subheading() should append a colon to the text when it does not already
   * end with a period.
   *
   * subheading("Target 1");
   * // output contains "Target 1:"
   */
  it("should append a colon when the text does not end with a period", () => {
    const lines = captureLog(() => subheading("Target 1"));
    expect(lines.join("\n")).toContain("Target 1:");
  });

  /**
   * subheading() should not append a colon when the text already ends with
   * a period, to avoid "Done.:" style double-punctuation.
   *
   * subheading("Done.");
   * // output contains "Done." but not "Done.:"
   */
  it("should not double-punctuate when text ends with a period", () => {
    const joined = captureLog(() => subheading("Done.")).join("\n");
    expect(joined).toContain("Done.");
    expect(joined).not.toContain("Done.:");
  });
});

// ---- showVar --------------------------------------------------------------------------------

describe("showVariable()", () => {
  /**
   * showVariable() should print both the variable name and its value to the console.
   *
   * showVariable("Config", "./my-config.js");
   * // output contains "Config" and "./my-config.js"
   */
  it("should include both the name and value in output", () => {
    const joined = captureLog(() => showVariable("Config", "./my-config.js")).join("\n");
    expect(joined).toContain("Config");
    expect(joined).toContain("./my-config.js");
  });

  /**
   * showVariable() should separate the name and value with a colon.
   *
   * showVariable("Strict", "false");
   * // output matches /Strict\s*:\s*false/
   */
  it("should separate name and value with a colon", () => {
    const lines = captureLog(() => showVariable("Strict", "false"));
    expect(lines.join("\n")).toMatch(/Strict\s*:\s*false/);
  });
});

// ---- showVariables -------------------------------------------------------------------------------

describe("showVariables()", () => {
  /**
   * showVariables() should print every key-value pair in the provided object.
   *
   * showVariables({ Config: "./cfg.js", Strict: "true" });
   * // output contains "Config", "./cfg.js", "Strict", "true"
   */
  it("should output all keys and values", () => {
    const joined = captureLog(() => showVariables({ Config: "./cfg.js", Strict: "true" })).join("\n");
    expect(joined).toContain("Config");
    expect(joined).toContain("./cfg.js");
    expect(joined).toContain("Strict");
    expect(joined).toContain("true");
  });
});

// ---- showCount ------------------------------------------------------------------------------

describe("showCount()", () => {
  /**
   * showCount() should print the numeric count and the entity label.
   *
   * showCount(5, "tokens");
   * // output contains "5" and "tokens"
   */
  it("should include the count and entity in output", () => {
    const joined = captureLog(() => showCount(5, "tokens")).join("\n");
    expect(joined).toContain("5");
    expect(joined).toContain("tokens");
  });

  /**
   * showCount() should default to the verb "Found" when none is provided.
   *
   * showCount(3, "files");
   * // output contains "Found"
   */
  it("should use the default verb 'Found'", () => {
    const lines = captureLog(() => showCount(3, "files"));
    expect(lines.join("\n")).toContain("Found");
  });

  /**
   * showCount() should use a custom verb when one is provided.
   *
   * showCount(3, "files", "", "Deleted");
   * // output contains "Deleted"
   */
  it("should use a custom verb when provided", () => {
    const lines = captureLog(() => showCount(3, "files", "", "Deleted"));
    expect(lines.join("\n")).toContain("Deleted");
  });

  /**
   * showCount() should indent the count line when a headingText is provided.
   *
   * showCount(5, "tokens", "My Heading");
   * // the line containing "tokens" starts with whitespace
   */
  it("should indent the count line when a headingText is provided", () => {
    const lines = captureLog(() => showCount(5, "tokens", "My Heading"));
    const countLine = lines.find(l => l.includes("tokens"));
    expect(countLine).toBeDefined();
    expect(countLine).toMatch(/^\s+/);
  });
});

// ---- displayError ---------------------------------------------------------------------------

describe("displayError()", () => {
  /**
   * displayError() should print the error text to the console.
   *
   * displayError("Something went wrong");
   * // output contains "Something went wrong"
   */
  it("should include the error text in output", () => {
    const lines = captureLog(() => displayError("Something went wrong"));
    expect(lines.join("\n")).toContain("Something went wrong");
  });

  /**
   * displayError() should print each line of a multi-line error message separately.
   *
   * displayError("Line one\nLine two");
   * // output contains both "Line one" and "Line two"
   */
  it("should handle multi-line error messages", () => {
    const joined = captureLog(() => displayError("Line one\nLine two")).join("\n");
    expect(joined).toContain("Line one");
    expect(joined).toContain("Line two");
  });
});

// ---- dryRunNotice ---------------------------------------------------------------------------

describe("dryRunNotice()", () => {
  /**
   * dryRunNotice() should include both a "Dry Run" label and the provided
   * notice text in its output.
   *
   * dryRunNotice("File will not be written.");
   * // output contains "Dry Run" and "File will not be written."
   */
  it("should include the notice text and a dry-run label", () => {
    const joined = captureLog(() => dryRunNotice("File will not be written.")).join("\n");
    expect(joined).toContain("Dry Run");
    expect(joined).toContain("File will not be written.");
  });
});

// ---- warning --------------------------------------------------------------------------------

describe("warning()", () => {
  /**
   * warning() should print the warning message text to the console.
   *
   * warning("This is IMPORTANT");
   * // output contains "This is"
   */
  it("should include the warning text in output", () => {
    const lines = captureLog(() => warning("This is IMPORTANT"));
    expect(lines.join("\n")).toContain("This is");
  });

  /**
   * warning() should include a "WARNING" banner label in its output.
   *
   * warning("Something important");
   * // output contains "WARNING"
   */
  it("should include a WARNING label", () => {
    const lines = captureLog(() => warning("Something important"));
    expect(lines.join("\n")).toContain("WARNING");
  });
});

// ---- header ---------------------------------------------------------------------------------

describe("header()", () => {
  /**
   * header() should print the CLI banner including the "Agent Configuration Manager"
   * tagline to the console.
   *
   * header();
   * // output contains "Agent Configuration Manager"
   */
  it("should output the CLI banner to the console", () => {
    const lines = captureLog(() => header());
    expect(lines.join("\n")).toContain("Agent Configuration Manager");
  });
});

// ---- footer ---------------------------------------------------------------------------------

describe("footer()", () => {
  /**
   * footer() should complete without throwing. It outputs blank lines
   * and has no return value to assert on.
   *
   * footer();
   * // does not throw
   */
  it("should output blank lines without throwing", () => {
    expect(() => captureLog(() => footer())).not.toThrow();
  });
});

// ---- dump -----------------------------------------------------------------------------------

describe("dump()", () => {
  /**
   * dump() should pass the object to console.dir for inspection.
   *
   * dump({ a: 1 });
   * // console.dir is called with { a: 1 }
   */
  it("should call console.dir with the object", () => {
    const spy = vi.spyOn(console, "dir").mockImplementation(() => {});
    dump({ a: 1 });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  /**
   * dump() should print a subheading before the object when headingText is provided.
   *
   * dump({ a: 1 }, "My Object");
   * // output contains "My Object"
   */
  it("should print a subheading when headingText is provided", () => {
    const spy = vi.spyOn(console, "dir").mockImplementation(() => {});
    const lines = captureLog(() => dump({ a: 1 }, "My Object"));
    expect(lines.join("\n")).toContain("My Object");
    spy.mockRestore();
  });
});

// ---- showCommandVars ------------------------------------------------------------------------

describe("showCommandVars()", () => {
  /**
   * showCommandVars() should print a "Command Variables" heading followed by
   * all key-value pairs in the provided object.
   *
   * showCommandVars({ Env: "production", Port: "3000" });
   * // output contains "Command Variables", "Env", "production", "Port", "3000"
   */
  it("should output all keys and values under a 'Command Variables' heading", () => {
    const joined = captureLog(() =>
      showCommandVars({ Env: "production", Port: "3000" })
    ).join("\n");
    expect(joined).toContain("Command Variables");
    expect(joined).toContain("Env");
    expect(joined).toContain("production");
    expect(joined).toContain("Port");
    expect(joined).toContain("3000");
  });

  /**
   * showCommandVars() should omit the "Dry Run" line entirely when dry-run mode
   * is off, since a "false" value there is just noise.
   *
   * showCommandVars({ Env: "production", "Dry Run": false });
   * // output does not contain "Dry Run"
   */
  it("should omit the 'Dry Run' line when its value is false", () => {
    const joined = captureLog(() =>
      showCommandVars({ Env: "production", "Dry Run": false })
    ).join("\n");
    expect(joined).toContain("Env");
    expect(joined).not.toContain("Dry Run");
  });

  /**
   * showCommandVars() should include the "Dry Run" line when dry-run mode is on.
   *
   * showCommandVars({ Env: "production", "Dry Run": true });
   * // output contains "Dry Run"
   */
  it("should include the 'Dry Run' line when its value is true", () => {
    const joined = captureLog(() =>
      showCommandVars({ Env: "production", "Dry Run": true })
    ).join("\n");
    expect(joined).toContain("Dry Run");
  });
});

// ---- scanStatus -----------------------------------------------------------------------------

describe("scanStatus()", () => {
  /**
   * scanStatus() should write an in-progress scan message to stdout containing
   * both the matched record count and the total scan count.
   *
   * scanStatus(42, 100);
   * // stdout contains "42" and "100"
   */
  it("should write matched and total counts to stdout", () => {
    const joined = captureStdout(() => scanStatus(42, 100)).join("");
    expect(joined).toContain("42");
    expect(joined).toContain("100");
  });
});

// ---- deleteStatus ---------------------------------------------------------------------------

describe("deleteStatus()", () => {
  /**
   * deleteStatus() should write an in-progress deletion message to stdout containing
   * both the deleted record count and the total records to delete.
   *
   * deleteStatus(7, 20);
   * // stdout contains "7" and "20"
   */
  it("should write deleted and total counts to stdout", () => {
    const joined = captureStdout(() => deleteStatus(7, 20)).join("");
    expect(joined).toContain("7");
    expect(joined).toContain("20");
  });
});

// ---- wrapText -------------------------------------------------------------------------------

describe("wrapText()", () => {
  /**
   * wrapText() should break a paragraph on spaces at the given width, never
   * inside a word, and never leave a line longer than the width unless one word
   * is longer than the width on its own.
   *
   * wrapText("one two three", 7, { hangingIndent: 0 });
   * // -> ["one two", "three"]
   */
  it("should wrap a paragraph on spaces at the given width", () => {
    expect(wrapText("one two three", 7, { hangingIndent: 0 })).toEqual(["one two", "three"]);
  });

  /**
   * A continuation line should hang two spaces past the line it continues, so a
   * wrapped sentence reads as one paragraph rather than as several.
   *
   * wrapText("one two three", 7);
   * // -> ["one two", "  three"]
   */
  it("should hang continuation lines two spaces by default", () => {
    expect(wrapText("one two three", 7)).toEqual(["one two", "  three"]);
  });

  /**
   * A line that arrives already indented should keep its indentation, and its
   * continuation lines should hang inside it rather than at the left margin.
   *
   * wrapText("    one two three", 11);
   * // -> ["    one two", "      three"]
   */
  it("should keep the indentation a line arrived with", () => {
    expect(wrapText("    one two three", 11)).toEqual(["    one two", "      three"]);
  });

  /**
   * A word longer than the width should be left whole on its own line, since
   * half a URL is less useful than a long line.
   *
   * wrapText("see https://example.com/a/very/long/path now", 10, { hangingIndent: 0 });
   * // -> ["see", "https://example.com/a/very/long/path", "now"]
   */
  it("should leave a word longer than the width whole", () => {
    const lines = wrapText("see https://example.com/a/very/long/path now", 10, {
      hangingIndent: 0,
    });
    expect(lines).toEqual(["see", "https://example.com/a/very/long/path", "now"]);
  });

  /**
   * Newlines already in the text should be honored: each line wraps on its own,
   * so a deliberate paragraph break survives.
   *
   * wrapText("a b\nc d", 3);
   * // -> ["a b", "c d"]
   */
  it("should wrap each existing line on its own", () => {
    expect(wrapText("a b\nc d", 3)).toEqual(["a b", "c d"]);
  });

  /**
   * Width should be measured with the color codes taken out, so a colored word
   * is counted by what a reader sees rather than by what the escapes add.
   */
  it("should measure width without the color escapes", () => {
    const colored = `[36mone[39m two`;
    expect(wrapText(colored, 7, { hangingIndent: 0 })).toEqual([colored]);
  });
});

// ---- formatVariable -------------------------------------------------------------------------

describe("formatVariable()", () => {
  /**
   * formatVariable() should indent by four, pad the label to the given width and
   * put the colon after it, so every key and value block lines up the same way.
   *
   * formatVariable({ label: "Repo", value: "qa" }, { labelWidth: 8 });
   * // -> ["    Repo    : qa"]
   */
  it("should indent by four and align the colon", () => {
    const lines = formatVariable({ label: "Repo", value: "qa" }, { labelWidth: 8 }).map(strip);
    expect(lines).toEqual(["    Repo    : qa"]);
  });

  /**
   * A trailing detail should follow the value rather than being wrapped in
   * parentheses, so the value stays the thing the eye lands on.
   */
  it("should write a detail after the value", () => {
    const lines = formatVariable(
      { label: "required-by", value: "core/sous-skills", detail: "https://example.com/x" },
      { labelWidth: 11 },
    ).map(strip);
    expect(lines).toEqual(["    required-by: core/sous-skills https://example.com/x"]);
  });

  /**
   * A value too long for the line should wrap under the value column, never
   * under the label.
   */
  it("should hang a wrapped value under the value column", () => {
    const lines = formatVariable(
      { label: "About", value: "one two three four five six" },
      { labelWidth: 5, width: 30 },
    ).map(strip);
    expect(lines[0]).toBe("    About: one two three four");
    expect(lines[1]).toBe("           five six");
  });

  /**
   * An empty label means "the same label as the line above, continued": the
   * label column and its colon are left blank.
   */
  it("should leave the label column blank for a continuation", () => {
    const lines = formatVariable({ label: "", value: "second" }, { labelWidth: 5 }).map(strip);
    expect(lines).toEqual(["           second"]);
  });
});

// ---- withErrorPrefix ------------------------------------------------------------------------

describe("withErrorPrefix()", () => {
  /**
   * withErrorPrefix() should add the literal "Error: " so an error is findable
   * when the output has no color at all.
   */
  it("should add the prefix to a plain message", () => {
    expect(withErrorPrefix("Something broke.")).toBe("Error: Something broke.");
  });

  /**
   * A message that already says it is an error should not be made to say it
   * twice.
   */
  it("should not double an existing prefix", () => {
    expect(withErrorPrefix("Error: Something broke.")).toBe("Error: Something broke.");
  });
});

// ---- keysHelpTip ----------------------------------------------------------------------------

describe("keysHelpTip()", () => {
  /**
   * keysHelpTip() should render the key and action pairs in the style the stock
   * select prompt uses: the key, its action beside it, pairs joined by a bullet.
   */
  it("should join the key and action pairs with a bullet", () => {
    expect(strip(keysHelpTip([["↑↓", "navigate"], ["⏎", "select"]]))).toBe(
      "↑↓ navigate • ⏎ select",
    );
  });
});

// ---- terminalColumns ------------------------------------------------------------------------

describe("terminalColumns()", () => {
  /**
   * terminalColumns() should report the stream's own width when it has one, and
   * fall back to the documented default when it does not, so a piped run always
   * wraps the same way.
   *
   * terminalColumns({ columns: 60 });  // -> 60
   * terminalColumns({});               // -> 100
   */
  it("should use the stream width when there is one and the default otherwise", () => {
    expect(terminalColumns({ columns: 60 })).toBe(60);
    expect(terminalColumns({})).toBe(DEFAULT_WRAP_COLUMNS);
    expect(terminalColumns({ columns: 0 })).toBe(DEFAULT_WRAP_COLUMNS);
  });
});
