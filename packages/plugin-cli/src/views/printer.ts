import type { Style } from "./style.js";
import { renderTable, type TableColumn, type TableOptions } from "./table.js";
import { displayWidth, indent, wrapColumnsOf, wrapText, type WrapOptions } from "./text.js";

/** How far a key and value block is indented. */
export const VARIABLE_INDENT = 4;

/** One key and value pair. */
export interface VariableEntry {
    /** The name on the left. An empty label continues the label above: its column is left blank. */
    label: string;
    /** The value after the colon. */
    value: unknown;
    /** A secondary fact (where it came from), muted after the value. */
    detail?: string;
}

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
 * Builds a view's lines, the way today's `src/utils/formatting.ts` wrote them to the console:
 * headings, key and value blocks, wrapped paragraphs, notes, warnings, errors and tables. Every
 * view builds its text with one, so the layout is decided in one place.
 *
 * ```ts
 * const out = new Printer(style, 100);
 *
 * out.section("Adding a repository");
 * out.variables({ Name: "main", URL: "https://github.com/acme/recipes" });
 *
 * return out.text();
 * ```
 */
export class Printer {
    readonly lines: string[] = [];

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

    /** Adds text as it is; each of its lines becomes a line. */
    log(text = ""): this {
        this.lines.push(...String(text).split("\n"));

        return this;
    }

    /** Adds lines as they are. */
    push(...lines: string[]): this {
        this.lines.push(...lines);

        return this;
    }

    /** A blank line (a single space, which some terminals need to keep it). */
    blank(count = 1): this {
        for (let index = 0; index < count; index++) {
            this.lines.push(" ");
        }

        return this;
    }

    /** The two blank lines that close a command's output. */
    footer(): this {
        return this.blank(2);
    }

    /** A blank line, then `▶ Text:` (a colon is added unless the text ends with a period). */
    heading(text: string, symbol = "▶"): this {
        this.blank();
        this.lines.push(this.style.heading(withSymbol(headingText(text), symbol)));

        return this;
    }

    /** A heading followed by a blank line: how a section of output opens. */
    section(text: string, symbol = "▶"): this {
        return this.heading(text, symbol).blank();
    }

    /** A blank line, then `➔ Text:`. */
    subheading(text: string, symbol = "➔"): this {
        this.blank();
        this.lines.push(this.style.subheading(withSymbol(headingText(text), symbol)));

        return this;
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
        const valueText = entry.value === undefined || entry.value === null ? "" : String(entry.value);
        const valueLines = wrapText(valueText, valueWidth, { hangingIndent: 0 });
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

    /** One key and value pair. */
    variable(label: string, value: unknown, options: VariableOptions & { detail?: string } = {}): this {
        const entry: VariableEntry = { label, value, ...(options.detail === undefined ? {} : { detail: options.detail }) };

        this.lines.push(...this.formatVariable(entry, options));

        return this;
    }

    /** Key and value pairs with their colons lined up. */
    variables(entries: Record<string, unknown> | readonly VariableEntry[], options: VariableOptions = {}): this {
        const list: readonly VariableEntry[] = Array.isArray(entries)
            ? (entries as readonly VariableEntry[])
            : Object.entries(entries).map(([label, value]) => ({ label, value }));

        if (list.length === 0) {
            return this;
        }

        const labelWidth = options.labelWidth ?? Math.max(...list.map((entry) => entry.label.length));

        for (const entry of list) {
            this.lines.push(...this.formatVariable(entry, { ...options, labelWidth }));
        }

        return this;
    }

    /** A paragraph's lines: wrapped to the width left after its indentation, indented and colored. */
    formatParagraph(text: string, options: ParagraphOptions = {}): string[] {
        const pad = Math.max(0, options.indent ?? 2);
        const width = options.width ?? this.wrapWidth;
        const paint = options.color ?? ((line: string) => line);
        const wrap: WrapOptions = options.hangingIndent === undefined ? {} : { hangingIndent: options.hangingIndent };

        return wrapText(text, Math.max(20, width - pad), wrap).map((line) => (line === "" ? " " : " ".repeat(pad) + paint(line)));
    }

    /** A wrapped, indented paragraph. */
    paragraph(text: string, options: ParagraphOptions = {}): this {
        this.lines.push(...this.formatParagraph(text, options));

        return this;
    }

    /** An explanatory paragraph, in the note color. */
    note(text: string, options: Omit<ParagraphOptions, "color"> = {}): this {
        return this.paragraph(text, { ...options, color: this.style.note });
    }

    /** `[Dry Run] text`, as a note indented four. */
    dryRunNotice(text: string): this {
        return this.note(`[Dry Run] ${text}`, { indent: 4 });
    }

    /** `Found [5] items`, under an optional subheading. */
    count(count: number, entity = "items", headingText = "", verb = "Found"): this {
        if (headingText) {
            this.subheading(headingText);
        }

        const prefix = verb ? `${verb} ` : "";
        const shown = this.style.cyan("[") + this.style.whiteBright(count.toLocaleString()) + this.style.cyan("]");
        const line = `${prefix}${shown} ${entity}`;

        this.lines.push(headingText ? indent(line) : line);

        return this;
    }

    /** A warning block: a `WARNING:` banner, then the text, its capitalized words highlighted. */
    warning(text: string): this {
        const style = this.style;

        this.lines.push("", "", style.banner("   WARNING:   "));

        for (const line of text.split("\n")) {
            if (line.trim() === "") {
                this.lines.push(" ");
                continue;
            }

            for (const wrapped of wrapText(line.trim(), this.wrapWidth - 2)) {
                this.lines.push(indent(style.warning(highlightUpperCaseWords(wrapped, style.highlight))));
            }
        }

        this.lines.push("");

        return this;
    }

    /** An error block: `Error: ` on the first line, every line trimmed and wrapped, in red. */
    error(text: string): this {
        const lines = text.split("\n").filter((line) => line.trim() !== "");

        this.lines.push("");
        lines.forEach((line, index) => {
            const body = index === 0 ? withErrorPrefix(line.trim()) : line.trim();

            for (const wrapped of wrapText(body, this.wrapWidth - 2)) {
                this.lines.push(indent(this.style.error(wrapped)));
            }
        });
        this.lines.push("", "");

        return this;
    }

    /** An error block that keeps the text's own indentation and blank lines. */
    errorBlock(text: string): this {
        const lines = text.split("\n");
        const first = lines.findIndex((line) => line.trim() !== "");

        this.lines.push("");
        lines.forEach((line, index) => {
            if (line === "") {
                this.lines.push(" ");
                return;
            }

            for (const wrapped of wrapText(index === first ? withErrorPrefix(line) : line, this.wrapWidth - 2)) {
                this.lines.push(indent(this.style.error(wrapped)));
            }
        });
        this.lines.push("", "");

        return this;
    }

    /** A table's lines, fitted to the output's width (see {@link renderTable}). */
    formatTable<Row extends Record<string, unknown>>(columns: TableColumn[], rows: Row[], options: TableOptions<Row> = {}): string[] {
        return renderTable(columns, rows, { style: this.style, stream: { columns: this.columns, isTTY: this.isTTY }, ...options });
    }

    /** A table, each line indented by `options.indent`. */
    table<Row extends Record<string, unknown>>(columns: TableColumn[], rows: Row[], options: TableOptions<Row> = {}): this {
        const pad = " ".repeat(options.indent ?? 0);

        this.lines.push(...this.formatTable(columns, rows, options).flatMap((line) => line.split("\n").map((part) => `${pad}${part}`)));

        return this;
    }

    /** Whether nothing was added. */
    get empty(): boolean {
        return this.lines.length === 0;
    }

    /** Every line, each ending with a newline; an empty string when there are none. */
    text(): string {
        return this.lines.length === 0 ? "" : `${this.lines.join("\n")}\n`;
    }
}

/** The prefix every error message carries, so it is findable with color off. */
export const ERROR_PREFIX = "Error: ";

/** Adds `Error: ` unless the text starts with it already. */
export function withErrorPrefix(text: string): string {
    return /^error:\s/i.test(text.trimStart()) ? text : `${ERROR_PREFIX}${text}`;
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
