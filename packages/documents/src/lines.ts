/**
 * Plain text files edited as a list of lines, such as `.gitignore`: test for a line, add one at a
 * chosen place, remove one, and keep a named block between two marker lines. Every line an edit
 * does not touch stays byte for byte, its own line ending included.
 */
import { ConfigError } from "@sous-io/plugin-api";

/** How a file type writes a comment: `#` for `.gitignore`, `<!--` and `-->` for Markdown. */
export interface CommentStyle {
    /** What starts a comment. */
    open: string;
    /** What ends it, for a comment that must be closed on its line. */
    close?: string;
}

/** `# comment`: `.gitignore`, `.dockerignore`, shell, YAML, TOML and most config files. */
export const HASH_COMMENTS: CommentStyle = Object.freeze({ open: "#" });

/** `<!-- comment -->`: Markdown, HTML and XML. */
export const HTML_COMMENTS: CommentStyle = Object.freeze({ open: "<!--", close: "-->" });

/** `// comment`: JavaScript, TypeScript, JSONC and the C family. */
export const SLASH_COMMENTS: CommentStyle = Object.freeze({ open: "//" });

/** `/* comment *\/`: CSS. */
export const CSS_COMMENTS: CommentStyle = Object.freeze({ open: "/*", close: "*/" });

/** `-- comment`: SQL and Lua. */
export const DASH_COMMENTS: CommentStyle = Object.freeze({ open: "--" });

/** `; comment`: INI files. */
export const SEMICOLON_COMMENTS: CommentStyle = Object.freeze({ open: ";" });

/**
 * Where a line or a block goes when it is added. `"end"` is the default. `after` and `before` name
 * a line already in the file; when it is not there, the new line goes at the end. `line` is a
 * line number counted from 1: the new line becomes that line, or goes at the end when the file is
 * shorter.
 */
export type LinePosition = "start" | "end" | { after: string } | { before: string } | { line: number };

/** Options for {@link parseLines}. */
export interface LinesOptions {
    /** How the file writes comments, for the marker lines of a block. Default {@link HASH_COMMENTS}. */
    comment?: CommentStyle;
    /** The file's name or path, named when a block is damaged. Default `"the file"`. */
    label?: string;
}

/** The two marker lines around a named block, as {@link managedBlockMarkers} writes them. */
export interface BlockMarkers {
    open: string;
    close: string;
}

/**
 * The marker lines of a block Sous keeps in a text file, in the file type's comment style.
 *
 * ```ts
 * managedBlockMarkers("session-files", HASH_COMMENTS);
 * // { open: "# >>> sous managed: session-files (do not edit between these markers)",
 * //   close: "# <<< sous managed: session-files" }
 * ```
 *
 * @throws Error when the name is empty or holds a line break.
 */
export function managedBlockMarkers(name: string, comment: CommentStyle = HASH_COMMENTS): BlockMarkers {
    if (name.trim() === "" || /[\r\n]/.test(name)) {
        throw new Error(`A managed block's name must be one line of text; got ${JSON.stringify(name)}.`);
    }

    const wrap = (text: string): string => (comment.close === undefined ? `${comment.open} ${text}` : `${comment.open} ${text} ${comment.close}`);

    return {
        open: wrap(`>>> sous managed: ${name} (do not edit between these markers)`),
        close: wrap(`<<< sous managed: ${name}`),
    };
}

/** One line: its text, and the line ending after it (`""` for a last line with none). */
interface Line {
    text: string;
    end: string;
}

/**
 * A plain text file as a list of lines.
 *
 * ```ts
 * const file = parseLines(fs.readFileSync(".gitignore", "utf8"), { comment: commentStyleForPath(".gitignore") });
 *
 * if (!file.includes("node_modules/")) file.insert("node_modules/", { after: "# dependencies" });
 * file.setBlock("session-files", ["docs/context/.kw-session-*"]);
 * fs.writeFileSync(".gitignore", file.toString());
 * ```
 *
 * Lines are compared exactly, without their line endings. A new line takes the file's usual line
 * ending (`\r\n` when the file has any, otherwise `\n`); a file with no final line break keeps
 * having none.
 */
export class LinesDocument {
    private readonly entries: Line[];
    private readonly eol: string;
    private readonly comment: CommentStyle;
    private readonly label: string;
    private readonly original: string;
    private edited = false;

    constructor(text: string, options: LinesOptions = {}) {
        this.original = text;
        this.eol = text.includes("\r\n") ? "\r\n" : "\n";
        this.comment = options.comment ?? HASH_COMMENTS;
        this.label = options.label ?? "the file";
        this.entries = splitLines(text);
    }

    /** The lines, without their line endings. */
    lines(): string[] {
        return this.entries.map((entry) => entry.text);
    }

    /** The number of lines. */
    length(): number {
        return this.entries.length;
    }

    /** Whether the file has this line. */
    includes(line: string): boolean {
        return this.indexOf(line) !== -1;
    }

    /** The index (from 0) of the first line equal to this one, or `-1`. */
    indexOf(line: string): number {
        return this.entries.findIndex((entry) => entry.text === line);
    }

    /**
     * Adds lines together at a position, whether or not they are already there (test with
     * {@link includes} first to add a line only when it is missing).
     *
     * @throws RangeError for a line number below 1, or not a whole number.
     */
    insert(lines: string | readonly string[], position: LinePosition = "end"): void {
        const added = typeof lines === "string" ? [lines] : [...lines];

        checkLines(added);

        if (added.length > 0) {
            this.splice(this.indexFor(position), 0, added);
        }
    }

    /**
     * Replaces `count` lines from index `start` (from 0) with `lines`. Lines outside that range
     * keep their text and line endings byte for byte; a file with no final line break keeps having
     * none.
     *
     * ```ts
     * file.replaceLines(2, 1, []);              // removes the third line
     * file.replaceLines(0, 0, ["# generated"]); // adds a first line
     * ```
     *
     * @throws RangeError when the range is outside the file.
     */
    replaceLines(start: number, count: number, lines: readonly string[]): void {
        checkLines(lines);

        if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0 || start + count > this.entries.length) {
            throw new RangeError(`Lines ${start} to ${start + count} are outside a file of ${this.entries.length} lines.`);
        }

        if (count === 0 && lines.length === 0) {
            return;
        }

        this.splice(start, count, [...lines]);
    }

    /**
     * Makes the file's lines these, changing only the lines between the first and the last that
     * differ, so every other line keeps its text and line ending byte for byte.
     *
     * ```ts
     * file.setLines([...file.lines(), "dist/"]);   // the same as file.insert("dist/")
     * ```
     */
    setLines(lines: readonly string[]): void {
        const current = this.lines();
        let prefix = 0;

        while (prefix < current.length && prefix < lines.length && current[prefix] === lines[prefix]) {
            prefix++;
        }

        let suffix = 0;

        while (
            suffix < current.length - prefix
            && suffix < lines.length - prefix
            && current[current.length - 1 - suffix] === lines[lines.length - 1 - suffix]
        ) {
            suffix++;
        }

        this.replaceLines(prefix, current.length - prefix - suffix, lines.slice(prefix, lines.length - suffix));
    }

    /** Removes every line equal to this one. Returns how many it removed. */
    remove(line: string): number {
        let removed = 0;

        for (let i = this.entries.length - 1; i >= 0; i--) {
            if (this.entries[i]!.text === line) {
                this.splice(i, 1, []);
                removed++;
            }
        }

        return removed;
    }

    /** The marker lines of a block in this file's comment style. */
    blockMarkers(name: string): BlockMarkers {
        return managedBlockMarkers(name, this.comment);
    }

    /**
     * The lines between a block's markers, or `undefined` when the file has no such block.
     *
     * @throws ConfigError when the block's markers are damaged (see {@link setBlock}).
     */
    block(name: string): string[] | undefined {
        const found = this.locate(name);

        return found === undefined ? undefined : this.entries.slice(found.open + 1, found.close).map((entry) => entry.text);
    }

    /** Whether the file has this block. */
    hasBlock(name: string): boolean {
        return this.locate(name) !== undefined;
    }

    /**
     * Sets the lines of a named block. An existing block keeps its marker lines and place, and
     * only what is between them changes. A missing block is added with its markers at `position`;
     * at the end, a blank line first separates it from the line before, and at the start, a blank
     * line after separates it from the line after.
     *
     * @throws ConfigError when an opening marker has no closing marker (or the reverse), or a
     *   marker appears twice: Sous never guesses where a damaged block ends.
     */
    setBlock(name: string, lines: readonly string[], position: LinePosition = "end"): void {
        checkLines(lines);

        const found = this.locate(name);

        if (found !== undefined) {
            const current = this.entries.slice(found.open + 1, found.close).map((entry) => entry.text);

            if (current.length !== lines.length || current.some((line, i) => line !== lines[i])) {
                this.splice(found.open + 1, found.close - found.open - 1, [...lines]);
            }

            return;
        }

        const markers = this.blockMarkers(name);
        const block = [markers.open, ...lines, markers.close];
        const at = this.indexFor(position);

        if (at === this.entries.length && at > 0 && this.entries[at - 1]!.text.trim() !== "") {
            block.unshift("");
        } else if (at === 0 && this.entries.length > 0 && this.entries[0]!.text.trim() !== "") {
            block.push("");
        }

        this.splice(at, 0, block);
    }

    /**
     * Removes a block, its marker lines included, and the blank line that separated it: the one
     * before it, or at the start of the file the one after it. Returns whether there was a block.
     *
     * @throws ConfigError when the block's markers are damaged (see {@link setBlock}).
     */
    removeBlock(name: string): boolean {
        const found = this.locate(name);

        if (found === undefined) {
            return false;
        }

        let from = found.open;
        let to = found.close + 1;

        if (from > 0 && this.entries[from - 1]!.text.trim() === "") {
            from--;
        } else if (from === 0 && to < this.entries.length && this.entries[to]!.text.trim() === "") {
            to++;
        }

        this.splice(from, to - from, []);

        return true;
    }

    /** The edited text. Until something changes, the original text, byte for byte. */
    toString(): string {
        if (!this.edited) {
            return this.original;
        }

        return this.entries.map((entry) => entry.text + entry.end).join("");
    }

    /** Whether any edit changed the text. */
    changed(): boolean {
        return this.edited && this.toString() !== this.original;
    }

    /** Where a position is, as the index the new lines start at. */
    private indexFor(position: LinePosition): number {
        if (position === "start") {
            return 0;
        }

        if (position === "end") {
            return this.entries.length;
        }

        if ("line" in position) {
            if (!Number.isInteger(position.line) || position.line < 1) {
                throw new RangeError(`A line number counts from 1; got ${position.line}.`);
            }

            return Math.min(position.line - 1, this.entries.length);
        }

        const anchor = "after" in position ? position.after : position.before;
        const index = this.indexOf(anchor);

        if (index === -1) {
            return this.entries.length;
        }

        return "after" in position ? index + 1 : index;
    }

    /** Replaces lines, giving new lines the file's line ending and keeping a missing final one missing. */
    private splice(start: number, count: number, lines: string[]): void {
        const atEnd = start + count === this.entries.length;
        const lastEnd = atEnd && this.entries.length > 0 ? this.entries[this.entries.length - 1]!.end : this.eol;
        const added = lines.map((text) => ({ text, end: this.eol }));

        // The line before new lines at the end needs a line ending now that something follows it.
        if (atEnd && start > 0 && added.length > 0 && this.entries[start - 1]!.end === "") {
            this.entries[start - 1]!.end = this.eol;
        }

        this.entries.splice(start, count, ...added);

        // The text's last line keeps whatever ending the last line had: none stays none.
        if (atEnd && this.entries.length > 0 && (added.length > 0 || count > 0)) {
            this.entries[this.entries.length - 1]!.end = lastEnd;
        }

        this.edited = true;
    }

    /** Finds a block's marker lines, checking they are whole. */
    private locate(name: string): { open: number; close: number } | undefined {
        const markers = this.blockMarkers(name);
        const opens: number[] = [];
        const closes: number[] = [];

        this.entries.forEach((entry, index) => {
            const text = entry.text.trim();

            if (text === markers.open) {
                opens.push(index);
            } else if (text === markers.close) {
                closes.push(index);
            }
        });

        if (opens.length === 0 && closes.length === 0) {
            return undefined;
        }

        if (opens.length === 1 && closes.length === 1 && opens[0]! < closes[0]!) {
            return { open: opens[0]!, close: closes[0]! };
        }

        throw new ConfigError(`The sous managed block "${name}" in ${this.label} is damaged.`, {
            details: [
                opens.length === 0
                    ? `The line '${markers.close}' is there, but the opening line '${markers.open}' is missing.`
                    : closes.length === 0
                        ? `It opens with '${markers.open}' but the line '${markers.close}' is missing, so sous cannot tell where the block ends.`
                        : `Each marker must appear once, the opening line first; found ${opens.length} opening and ${closes.length} closing lines.`,
                "Fix the marker lines, or delete the block whole, and run the command again.",
            ],
        });
    }
}

/**
 * Reads a plain text file as a list of lines.
 *
 * ```ts
 * parseLines("dist/\nnode_modules/\n").includes("dist/");   // true
 * ```
 */
export function parseLines(text: string, options: LinesOptions = {}): LinesDocument {
    return new LinesDocument(text, options);
}

function splitLines(text: string): Line[] {
    const entries: Line[] = [];
    const pattern = /\r?\n/g;
    let start = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
        entries.push({ text: text.slice(start, match.index), end: match[0] });
        start = match.index + match[0].length;
    }

    if (start < text.length) {
        entries.push({ text: text.slice(start), end: "" });
    }

    return entries;
}

function checkLines(lines: readonly string[]): void {
    for (const line of lines) {
        if (/[\r\n]/.test(line)) {
            throw new Error(`A line cannot hold a line break; got ${JSON.stringify(line)}.`);
        }
    }
}
