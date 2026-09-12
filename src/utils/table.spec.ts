import { describe, expect, it } from "vitest";
import { renderTable, type TableColumn } from "./table.js";

/** Drops the color escape codes so a test asserts on what a reader sees. */
const strip = (line: string): string => line.replace(/\u001B\[[0-9;]*m/g, "");

/** Renders and strips in one step, because every assertion wants plain lines. */
function render(
  columns: TableColumn[],
  rows: Array<Record<string, string>>,
  options: Parameters<typeof renderTable>[2] = {}
): string[] {
  return renderTable(columns, rows, options).map(strip);
}

describe("renderTable()", () => {
  /**
   * A table that fits keeps every column at its natural width: as wide as its
   * widest cell or its heading, whichever is wider. Numbers align to the right,
   * and no line carries trailing spaces.
   *
   * renderTable([{ key: "name", header: "Name" }, ...], [{ name: "alpha", size: "3" }], { width: 40 });
   * // -> ["Name   Size", "-----  ----", "alpha     3", ...]
   */
  it("should lay every column out at its natural width when the table fits", () => {
    const lines = render(
      [
        { key: "name", header: "Name" },
        { key: "size", header: "Size", kind: "number" },
      ],
      [
        { name: "alpha", size: "3" },
        { name: "beta", size: "12" },
      ],
      { width: 40 }
    );

    expect(lines).toEqual(["Name   Size", "-----  ----", "alpha     3", "beta     12"]);
  });

  /**
   * When the natural widths do not fit, every column gives width back in
   * proportion to how far it sits above its own minimum: a column with three
   * times the room to give gives three times as much.
   *
   * Two columns wanting 20 and 10 columns, squeezed into 18, end up 11 and 7.
   */
  it("should shrink the columns in proportion to the room each has", () => {
    const lines = render(
      [
        { key: "left", header: "L", overflow: "truncate" },
        { key: "right", header: "R", overflow: "truncate" },
      ],
      [{ left: "l".repeat(20), right: "r".repeat(10) }],
      { width: 20, header: true }
    );

    const [, rule] = lines;
    expect(rule).toBe(`${"-".repeat(11)}  ${"-".repeat(7)}`);
  });

  /**
   * A shortfall comes out of the columns that matter least before it touches
   * the ones that matter, so an identifier is not cut in half while a sentence
   * beside it keeps every character.
   *
   * Two twenty-wide columns in an eighteen-wide budget, one of them low: the
   * low one alone gives up the whole twenty-two columns it can spare.
   */
  it("should take the shortfall out of the least important columns first", () => {
    const lines = render(
      [
        { key: "key", header: "K", overflow: "truncate" },
        { key: "note", header: "N", overflow: "truncate", priority: "low" },
      ],
      [{ key: "k".repeat(20), note: "n".repeat(20) }],
      { width: 30 }
    );

    expect(lines[1]).toBe(`${"-".repeat(20)}  ${"-".repeat(8)}`);
  });

  /**
   * A wrapping cell breaks at its column's edge and makes the whole row taller;
   * the other cells in that row are padded with blank space underneath, so the
   * columns stay lined up.
   */
  it("should wrap a long cell and pad the rest of the row with blank lines", () => {
    const lines = render(
      [
        { key: "name", header: "Name", minWidth: 4 },
        { key: "about", header: "About", overflow: "wrap" },
      ],
      [{ name: "alpha", about: "one two three four five" }],
      { width: 20 }
    );

    const body = lines.slice(2);
    expect(body.length).toBeGreaterThan(1);
    expect(body[0]).toMatch(/^alpha {2}\S/);
    // Continuation lines carry only the wrapped column, indented under it.
    expect(body[1]).toMatch(/^ {7}\S/);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20);
  });

  /**
   * A truncated cell is cut on the side the column asked for, and the cut is
   * marked with a single character so the reader can see something was left out.
   *
   * "abcdefghij" in five columns -> "abcd…" (end), "…ghij" (start), "ab…ij" (middle).
   */
  it("should cut a cell on the side the column asked for", () => {
    const cut = (side: "start" | "middle" | "end"): string => {
      const lines = render(
        [{ key: "value", header: "V", overflow: "truncate", truncate: side }],
        [{ value: "abcdefghij" }],
        { width: 5, header: false }
      );
      return lines[0]!;
    };

    expect(cut("end")).toBe("abcd…");
    expect(cut("start")).toBe("…ghij");
    expect(cut("middle")).toBe("ab…ij");
  });

  /**
   * A URL column takes the middle cut without being told to, because the host at
   * the front and the repository name at the end are both worth keeping.
   */
  it("should cut a URL in the middle by default", () => {
    const lines = render(
      [{ key: "url", header: "U", overflow: "truncate", kind: "url" }],
      [{ url: "https://github.com/sous-io/sous.git" }],
      { width: 15, header: false }
    );

    expect(lines[0]).toBe("https:/…ous.git");
  });

  /**
   * Width left over after every column has what it needs goes to the columns
   * that asked to flex, in proportion to what each asked for.
   *
   * Two five-wide columns in an eighteen-wide budget: the flexing one takes the
   * whole eight columns of slack.
   */
  it("should hand leftover width to the columns that flex", () => {
    const lines = render(
      [
        { key: "left", header: "L", flex: 1 },
        { key: "right", header: "R" },
      ],
      [{ left: "aaaaa", right: "bbbbb" }],
      { width: 20 }
    );

    expect(lines[1]).toBe(`${"-".repeat(13)}  ${"-".repeat(5)}`);
  });

  /**
   * A column never shrinks below its stated minimum, however tight the window
   * gets; the width comes out of the columns that still have room instead.
   */
  it("should never squeeze a column below its minimum width", () => {
    const lines = render(
      [
        { key: "left", header: "L", overflow: "truncate", minWidth: 15 },
        { key: "right", header: "R", overflow: "truncate" },
      ],
      [{ left: "l".repeat(20), right: "r".repeat(20) }],
      { width: 20 }
    );

    const dashes = lines[1]!.split("  ");
    expect(dashes[0]!.length).toBeGreaterThanOrEqual(15);
  });

  /**
   * When even the minimum widths do not fit, the least important column steps
   * aside first, and the rightmost of two equally unimportant ones goes before
   * the other. One plain line under the table names what was hidden.
   */
  it("should hide the least important columns and say which ones went", () => {
    const columns: TableColumn[] = [
      { key: "a", header: "A", minWidth: 10 },
      { key: "b", header: "B", minWidth: 10, priority: "medium" },
      { key: "c", header: "C", minWidth: 10, priority: "low" },
      { key: "d", header: "D", minWidth: 10, priority: "low" },
    ];

    const lines = render(columns, [{ a: "a", b: "b", c: "c", d: "d" }], { width: 30 });

    expect(lines[0]).toBe("A           B");
    expect(lines.at(-1)).toBe(
      "Hidden at this width: C, D. Widen the terminal to see them."
    );
  });

  /**
   * Hiding a single column says "it", not "them", because the output is read by
   * people.
   */
  it("should name a single hidden column in the singular", () => {
    const lines = render(
      [
        { key: "a", header: "A", minWidth: 20 },
        { key: "b", header: "B", minWidth: 20, priority: "low" },
      ],
      [{ a: "a", b: "b" }],
      { width: 30 }
    );

    expect(lines.at(-1)).toBe("Hidden at this width: B. Widen the terminal to see it.");
  });

  /**
   * A column marked high importance is never hidden, even when the window
   * cannot hold it; the columns are squeezed instead, so the table still fits.
   */
  it("should squeeze rather than hide a table of important columns", () => {
    const lines = render(
      [
        { key: "a", header: "A", minWidth: 20, overflow: "truncate" },
        { key: "b", header: "B", minWidth: 20, overflow: "truncate" },
      ],
      [{ a: "a".repeat(30), b: "b".repeat(30) }],
      { width: 20 }
    );

    expect(lines.some((line) => line.startsWith("Hidden at this width"))).toBe(false);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(20);
  });

  /**
   * Output that is not going to a terminal is laid out at the default width and
   * never loses a column, so a piped or recorded run always shows everything.
   */
  it("should keep every column when the output is not a terminal", () => {
    const columns: TableColumn[] = [
      { key: "a", header: "A", minWidth: 10 },
      { key: "b", header: "B", minWidth: 10, priority: "low" },
      { key: "c", header: "C", minWidth: 10, priority: "low" },
    ];
    const rows = [{ a: "a", b: "b", c: "c" }];

    const piped = render(columns, rows, { stream: { columns: 30, isTTY: false } });
    expect(piped.some((line) => line.startsWith("Hidden at this width"))).toBe(false);
    expect(piped[0]).toContain("C");

    const terminal = render(columns, rows, { stream: { columns: 30, isTTY: true } });
    expect(terminal.at(-1)).toContain("Hidden at this width: C.");
  });

  /**
   * A colored cell is measured by what it shows, not by how many bytes it takes,
   * so color never knocks a column out of line.
   */
  it("should measure a colored cell by its visible width", () => {
    const lines = renderTable(
      [
        { key: "name", header: "Name" },
        { key: "note", header: "Note" },
      ],
      [
        { name: "\u001B[36malpha\u001B[39m", note: "first" },
        { name: "beta", note: "second" },
      ],
      { width: 40 }
    );

    expect(strip(lines[2]!)).toBe("alpha  first");
    expect(strip(lines[3]!)).toBe("beta   second");
  });

  /**
   * Cutting a colored cell keeps the color codes and closes them, so a truncated
   * cell never leaves the rest of the line stuck in a color.
   */
  it("should keep a colored cell readable when it is cut", () => {
    const lines = renderTable(
      [{ key: "value", header: "V", overflow: "truncate" }],
      [{ value: "\u001B[36mabcdefghij\u001B[39m" }],
      { width: 5, header: false }
    );

    expect(strip(lines[0]!)).toBe("abcd…");
    expect(lines[0]).toContain("\u001B[36m");
    expect(lines[0]).toContain("\u001B[0m");
  });

  /**
   * The indentation a caller adds comes out of the width budget, so an indented
   * table fits its window rather than running two columns past the edge.
   */
  it("should take the caller's indentation out of the budget", () => {
    const columns: TableColumn[] = [
      { key: "left", header: "L", overflow: "truncate" },
      { key: "right", header: "R", overflow: "truncate" },
    ];
    const rows = [{ left: "l".repeat(20), right: "r".repeat(20) }];

    const flush = render(columns, rows, { width: 30 });
    const indented = render(columns, rows, { width: 30, indent: 10 });

    for (const line of flush) expect(line.length).toBeLessThanOrEqual(30);
    for (const line of indented) expect(line.length).toBeLessThanOrEqual(20);
  });

  /**
   * A row note is printed under its row, which is how a command shows a detail
   * that does not deserve a column of its own.
   */
  it("should print a row note under the row it belongs to", () => {
    const lines = render(
      [{ key: "name", header: "Name" }],
      [{ name: "alpha" }, { name: "beta" }],
      { width: 40, rowNote: (row) => (row.name === "alpha" ? "  about alpha" : undefined) }
    );

    expect(lines).toEqual(["Name", "-----", "alpha", "  about alpha", "beta"]);
  });

  /**
   * A table with no rows still prints its headings, so the reader learns what
   * the command would have shown.
   */
  it("should print the headings of an empty table", () => {
    const lines = render([{ key: "name", header: "Name" }], [], { width: 40 });
    expect(lines).toEqual(["Name", "----"]);
  });
});
