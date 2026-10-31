import type { VariableEntry } from "@sous-io/plugin-api";
import type { Style } from "../views/style.js";
import { renderTable, type TableColumn, type TableOptions } from "../views/table.js";
import { displayWidth, indent, wrapColumnsOf, wrapText, type WrapOptions } from "../views/text.js";

/** How far a key and value block is indented. */
export const VARIABLE_INDENT = 4;

/** The prefix every error message carries, so it is findable with color off. */
export const ERROR_PREFIX = "Error: ";

/** A blank line: a single space, which some terminals need to keep it. */
export const BLANK = " ";

/** How a key and value block is laid out. */
export interface VariableOptions {
    /** How far the block is indented. Default 4. */
    indent?: number;
    /** The column the colons line up at. Default: the longest label. */
    labelWidth?: number;
    /** The column values wrap at. Default: the wrap width. */
    width?: number;
}

/** How a paragraph is laid out. */
export interface ParagraphOptions extends WrapOptions {
    /** How far the whole paragraph is indented. Default 2. */
    indent?: number;
    /** The column it wraps at, indentation included. Default: the wrap width. */
    width?: number;
    /** A color for every line. */
    color?: (text: string) => string;
}

/**
 * Builds the lines of every shape the terminal shows, the way the CLI's `src/utils/formatting.ts`
 * wrote them before the refactor: headings, key and value blocks, wrapped paragraphs, notes,
 * warnings, errors and tables. It only builds lines; the terminal reporter decides which entry
 * gets which shape, and where the blank lines go.
 *
 * ```ts
 * const layout = new Layout(createStyle(false), 100);
 *
 * layout.heading("Adding a repository");   // "▶ Adding a repository:"
 * layout.variableLines([{ label: "Name", value: "main" }]);   // ["    Name: main"]
 * ```
 */
export class Layout {
    /**
     * @param style - The colors.
     * @param columns - The columns the output has.
     * @param isTTY - Whether the output is a terminal (tables may hide columns only then).
     */
    constructor(
        readonly style: Style,
        readonly columns = 100,
        readonly isTTY = false,
    ) {}

    /** The width paragraphs wrap to. */
    get wrapWidth(): number {
        return wrapColumnsOf(this.columns);
    }

    /** `▶ Text:` (a colon is added unless the text ends with a period). */
    heading(text: string, symbol = "▶"): string {
        return this.style.heading(withSymbol(headingText(text), symbol));
    }

    /** `➔ Text:`. */
    subheading(text: string, symbol = "➔"): string {
        return this.style.subheading(withSymbol(headingText(text), symbol));
    }

    /**
     * The lines of one key and value pair: the label padded so the colons line up, the value, then
     * any detail muted. A long value wraps and hangs under the value column.
     */
    formatVariable(entry: VariableEntry, options: VariableOptions = {}): string[] {
        const style = this.style;
        const pad = " ".repeat(Math.max(0, options.indent ?? VARIABLE_INDENT));
        const labelWidth = Math.max(options.labelWidth ?? entry.label.length, entry.label.length);
        const gutter = labelWidth + 2;
        const width = options.width ?? this.wrapWidth;
        const valueWidth = Math.max(20, width - pad.length - gutter);
        const valueLines = wrapText(valueText(entry.value), valueWidth, { hangingIndent: 0 });
        const detailLines = entry.detail === undefined || entry.detail === "" ? [] : wrapText(entry.detail, valueWidth, { hangingIndent: 0 });
        const cells = valueLines.map((line) => style.value(line));

        if (detailLines.length > 0) {
            const last = valueLines[valueLines.length - 1] ?? "";
            const [first = "", ...rest] = detailLines;

            if (last !== "" && displayWidth(last) + 1 + displayWidth(first) <= valueWidth) {
                cells[cells.length - 1] = `${style.value(last)} ${style.muted(first)}`;
            } else {
                cells.push(style.muted(first));
            }

            for (const line of rest) {
                cells.push(style.muted(line));
            }
        }

        if (cells.length === 0) {
            cells.push("");
        }

        return cells.map((cell, index) =>
            index === 0 && entry.label !== "" ? `${pad}${style.label(entry.label.padEnd(labelWidth))}: ${cell}` : `${pad}${" ".repeat(gutter)}${cell}`,
        );
    }

    /** Key and value pairs with their colons lined up. */
    variableLines(entries: readonly VariableEntry[], options: VariableOptions = {}): string[] {
        if (entries.length === 0) {
            return [];
        }

        const labelWidth = options.labelWidth ?? Math.max(...entries.map((entry) => entry.label.length));

        return entries.flatMap((entry) => this.formatVariable(entry, { ...options, labelWidth }));
    }

    /** A paragraph's lines: wrapped to the width left after its indentation, indented and colored. */
    paragraphLines(text: string, options: ParagraphOptions = {}): string[] {
        const pad = Math.max(0, options.indent ?? 2);
        const width = options.width ?? this.wrapWidth;
        const paint = options.color ?? ((line: string) => line);
        const wrap: WrapOptions = options.hangingIndent === undefined ? {} : { hangingIndent: options.hangingIndent };

        return wrapText(text, Math.max(20, width - pad), wrap).map((line) => (line === "" ? BLANK : " ".repeat(pad) + paint(line)));
    }

    /** An explanatory paragraph, in the note color. */
    noteLines(text: string, options: Omit<ParagraphOptions, "color"> = {}): string[] {
        return this.paragraphLines(text, { ...options, color: this.style.note });
    }

    /** `[Dry Run] text`, as a note indented four. */
    dryRunLines(text: string): string[] {
        return this.noteLines(`[Dry Run] ${text}`, { indent: 4 });
    }

    /** `Found [5] items`. */
    countLine(count: number, entity: string, verb = "Found"): string {
        const prefix = verb ? `${verb} ` : "";
        const shown = this.style.cyan("[") + this.style.whiteBright(count.toLocaleString()) + this.style.cyan("]");

        return `${prefix}${shown} ${entity}`;
    }

    /** A warning block: a `WARNING:` banner, then the text, its capitalized words highlighted. */
    warningLines(text: string): string[] {
        const style = this.style;
        const lines = [style.banner("   WARNING:   ")];

        for (const line of text.split("\n")) {
            if (line.trim() === "") {
                lines.push(BLANK);
                continue;
            }

            for (const wrapped of wrapText(line.trim(), this.wrapWidth - 2)) {
                lines.push(indent(style.warning(highlightUpperCaseWords(wrapped, style.highlight))));
            }
        }

        return lines;
    }

    /**
     * An error block: the prefix on the first line, every line wrapped, in red. A line keeps its own
     * indentation; the lines are not trimmed.
     */
    errorLines(text: string, prefix = ERROR_PREFIX): string[] {
        const lines = text.split("\n");
        const first = lines.findIndex((line) => line.trim() !== "");
        const out: string[] = [];

        lines.forEach((line, index) => {
            if (line.trim() === "") {
                out.push(BLANK);
                return;
            }

            const body = index === first ? withPrefix(line.trimStart(), prefix) : line;

            for (const wrapped of wrapText(body, this.wrapWidth - 2)) {
                out.push(this.style.error(wrapped));
            }
        });

        return out;
    }

    /** A table's lines, fitted to the output's width (see {@link renderTable}). */
    tableLines<Row extends Record<string, unknown>>(columns: TableColumn[], rows: Row[], options: TableOptions<Row> = {}): string[] {
        const pad = " ".repeat(options.indent ?? 0);

        return renderTable(columns, rows, { style: this.style, stream: { columns: this.columns, isTTY: this.isTTY }, ...options }).flatMap((line) =>
            line.split("\n").map((part) => `${pad}${part}`),
        );
    }
}

/** Adds `Error: ` unless the text starts with it already. */
export function withErrorPrefix(text: string): string {
    return withPrefix(text, ERROR_PREFIX);
}

/** Adds a prefix unless the text starts with it already (ignoring case). */
function withPrefix(text: string, prefix: string): string {
    return text.trimStart().toLowerCase().startsWith(prefix.toLowerCase()) ? text : `${prefix}${text}`;
}

/** A value as the text a key and value block shows: nothing for `undefined` and `null`, JSON for an object. */
export function valueText(value: unknown): string {
    if (value === undefined || value === null) {
        return "";
    }

    if (Array.isArray(value) && value.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))) {
        return value.join(", ");
    }

    if (typeof value === "object") {
        try {
            return JSON.stringify(value, null, 2) ?? String(value);
        } catch {
            return String(value);
        }
    }

    return String(value);
}

function headingText(text: string): string {
    return text.endsWith(".") ? text : `${text}:`;
}

function withSymbol(text: string, symbol: string): string {
    return symbol ? `${symbol} ${text}` : text;
}

function highlightUpperCaseWords(text: string, paint: (word: string) => string): string {
    return text.replace(/\b[A-Z][A-Z_'"()[\]{}<>|&*!@#%^\\-]+\b/g, (match) => paint(match));
}
