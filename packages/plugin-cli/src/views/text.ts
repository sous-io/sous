/**
 * Measuring and wrapping text, ported from today's `src/utils/formatting.ts`. Width is always
 * measured with the color codes taken out.
 */

/** The SGR escape sequences the style helpers emit. */
const SGR_PATTERN = /\u001B\[[0-9;]*m/g;

/** The width prose is wrapped to when the output is not a terminal or never said how wide it is. */
export const DEFAULT_WRAP_COLUMNS = 100;

/** How far short of the right edge text stops. */
export const RIGHT_MARGIN = 2;

/** The character every bulleted line is drawn with. */
export const BULLET = "•";

/** Removes color escape sequences. */
export function stripAnsi(text: string): string {
    return String(text ?? "").replace(SGR_PATTERN, "");
}

/** How many columns a string occupies once its color codes are taken out. */
export function displayWidth(text: string): number {
    return stripAnsi(text).length;
}

/** The columns a stream has: its own width on a terminal, {@link DEFAULT_WRAP_COLUMNS} otherwise. */
export function terminalColumns(stream: { readonly columns?: number } | undefined): number {
    const columns = stream?.columns;

    return typeof columns === "number" && columns > 0 ? columns : DEFAULT_WRAP_COLUMNS;
}

/** The width paragraphs wrap to: the columns less the right margin. */
export function wrapColumnsOf(columns: number): number {
    return Math.max(20, columns - RIGHT_MARGIN);
}

/** Indents every line of a block. */
export function indent(text: string, count = 2, char = " "): string {
    return text
        .split("\n")
        .map((line) => char.repeat(count) + line)
        .join("\n");
}

/** How a paragraph is wrapped. */
export interface WrapOptions {
    /** How far a continuation line hangs past the first line. Default 2. */
    hangingIndent?: number;
}

/**
 * Wraps a paragraph to a width, breaking on spaces and never inside a word. A word longer than the
 * width (a URL, a path) is left whole on a line of its own. Newlines in the text are kept, and each
 * line keeps its own indentation.
 *
 * ```ts
 * wrapText("one two three", 7, { hangingIndent: 0 }); // ["one two", "three"]
 * ```
 */
export function wrapText(text: string, width: number, options: WrapOptions = {}): string[] {
    const limit = Math.max(1, Math.floor(width));
    const hanging = Math.max(0, Math.floor(options.hangingIndent ?? 2));
    const lines: string[] = [];

    for (const paragraph of String(text ?? "").split("\n")) {
        const leading = /^[ \t]*/.exec(paragraph)?.[0] ?? "";
        const words = paragraph
            .slice(leading.length)
            .split(/\s+/)
            .filter((word) => word.length > 0);

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

            if (displayWidth(prefix) + displayWidth(current) + 1 + displayWidth(word) <= limit) {
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

/** Pluralizes a count: `1 file`, `2 files`. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
    return `${count} ${count === 1 ? singular : pluralForm}`;
}
