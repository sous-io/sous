/**
 * The one parser of `.sous/.env` and `.sous/.env.local` (S6: one implementation, L2), with its
 * line-preserving editor.
 *
 * These files belong to the user: hand-written, commented, ordered on purpose, and (for `.env`)
 * committed. So sous edits them the way a careful person would. The file is parsed into a line
 * model, one line is rewritten or appended, and every other byte comes back out unchanged:
 * comments, blank lines, order, quoting and the `export ` prefix all survive.
 *
 * Supported syntax (deliberately small; this is not a shell):
 *   - `KEY=value`
 *   - `export KEY=value` (the `export ` prefix is ignored)
 *   - `# comment` lines and blank lines are skipped
 *   - single- or double-quoted values are unquoted; `\n` and `\t` inside double quotes become real
 *     newlines and tabs
 *   - an unquoted value has a trailing ` # comment` stripped and is trimmed
 *
 * Lines without `=` are ignored rather than treated as errors, so a stray note cannot break a build.
 */

import fs from "node:fs";
import path from "node:path";

/** The key syntax accepted on an assignment line. */
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parses env file text into a flat map, in file order; later duplicates win.
 *
 * ```ts
 * parseEnv('A=1\nexport B="two words" # note\n');   // { A: "1", B: "two words" }
 * ```
 */
export function parseEnv(content: string): Record<string, string> {
    const result: Record<string, string> = {};

    for (const line of parseEnvFile(content).lines) {
        if (line.kind === "assignment") {
            result[line.key] = unquote(line.rawValue);
        }
    }

    return result;
}

/** Unquotes and cleans up the right-hand side of a `KEY=value` line. */
function unquote(raw: string): string {
    const trimmed = raw.trim();

    if (trimmed.startsWith('"')) {
        const end = findClosingQuote(trimmed, '"');

        if (end !== -1) {
            return trimmed.slice(1, end).replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');
        }
    }

    if (trimmed.startsWith("'")) {
        const end = findClosingQuote(trimmed, "'");

        if (end !== -1) {
            return trimmed.slice(1, end);
        }
    }

    // An unquoted (or unterminated) value: an inline comment goes, then the spaces around it.
    const commentAt = trimmed.search(/\s#/);

    return (commentAt === -1 ? trimmed : trimmed.slice(0, commentAt)).trim();
}

/** The index of the quote that closes a value starting with `quote`, skipping escaped quotes; -1 when unterminated. */
function findClosingQuote(value: string, quote: string): number {
    for (let i = 1; i < value.length; i++) {
        if (value[i] === "\\") {
            i++;
            continue;
        }

        if (value[i] === quote) {
            return i;
        }
    }

    return -1;
}

/** One line of an env file, classified. */
export type EnvFileLine =
    /** An empty or whitespace-only line. */
    | { kind: "blank"; text: string }
    /** A whole-line comment. */
    | { kind: "comment"; text: string }
    /** A `KEY=value` assignment, with everything needed to rewrite just the value. */
    | {
          kind: "assignment";
          text: string;
          /** Leading whitespace, kept on rewrite. */
          indent: string;
          /** True when the line had an `export ` prefix. */
          exported: boolean;
          key: string;
          /** The value as written, before unquoting. */
          rawValue: string;
          /** A trailing ` # comment`, with its spacing. */
          inlineComment: string;
      }
    /** Anything else: kept as written, never read. */
    | { kind: "other"; text: string };

/** A parsed env file: its lines, and how to put them back together. */
export interface EnvFileModel {
    lines: EnvFileLine[];
    /** The line ending the file uses. */
    eol: "\n" | "\r\n";
    /** True when the file ended with a newline (or is empty and will). */
    trailingNewline: boolean;
}

/**
 * Splits an assignment's right-hand side into the value and any trailing comment. A quoted value is
 * scanned to its closing quote first, so a `#` inside quotes is part of the value.
 */
function splitValueAndComment(raw: string): { rawValue: string; inlineComment: string } {
    const leadingSpaces = raw.length - raw.trimStart().length;
    const body = raw.trimStart();
    const quote = body.startsWith('"') ? '"' : body.startsWith("'") ? "'" : undefined;

    if (quote !== undefined) {
        const end = findClosingQuote(body, quote);

        if (end !== -1) {
            return { rawValue: raw.slice(0, leadingSpaces + end + 1), inlineComment: raw.slice(leadingSpaces + end + 1) };
        }

        return { rawValue: raw, inlineComment: "" };
    }

    const commentAt = body.search(/\s#/);

    if (commentAt === -1) {
        return { rawValue: raw, inlineComment: "" };
    }

    // Every space before the comment belongs to the comment, so it survives a rewrite of the value.
    let start = leadingSpaces + commentAt;

    while (start > 0 && /\s/.test(raw[start - 1]!)) {
        start--;
    }

    return { rawValue: raw.slice(0, start), inlineComment: raw.slice(start) };
}

/** Parses env file text into a line model. Nothing is dropped: a line not understood is kept as `other`. */
export function parseEnvFile(content: string): EnvFileModel {
    const eol: "\n" | "\r\n" = content.includes("\r\n") ? "\r\n" : "\n";
    const trailingNewline = content.length === 0 || content.endsWith("\n");
    const body = content.endsWith("\r\n") ? content.slice(0, -2) : content.endsWith("\n") ? content.slice(0, -1) : content;
    const rawLines = content.length === 0 ? [] : body.split(/\r?\n/);

    const lines: EnvFileLine[] = rawLines.map((text) => {
        if (text.trim() === "") {
            return { kind: "blank", text };
        }

        if (text.trimStart().startsWith("#")) {
            return { kind: "comment", text };
        }

        const indent = text.slice(0, text.length - text.trimStart().length);
        const withoutIndent = text.slice(indent.length);
        const exported = withoutIndent.startsWith("export ");
        const assignment = exported ? withoutIndent.slice(7).trimStart() : withoutIndent;
        const equals = assignment.indexOf("=");

        if (equals <= 0) {
            return { kind: "other", text };
        }

        const key = assignment.slice(0, equals).trim();

        if (!KEY_PATTERN.test(key)) {
            return { kind: "other", text };
        }

        const { rawValue, inlineComment } = splitValueAndComment(assignment.slice(equals + 1));

        return { kind: "assignment", text, indent, exported, key, rawValue, inlineComment };
    });

    return { lines, eol, trailingNewline };
}

/** Renders a line model back to text. */
export function renderEnvFile(model: EnvFileModel): string {
    if (model.lines.length === 0) {
        return "";
    }

    const body = model.lines.map((line) => line.text).join(model.eol);

    return model.trailingNewline ? body + model.eol : body;
}

/**
 * Quotes a value when it needs quoting, so the parser reads back exactly what was written. An
 * ordinary word stays bare.
 *
 * ```ts
 * quoteEnvValue("plain");       // "plain"
 * quoteEnvValue("two words");   // "\"two words\""
 * ```
 */
export function quoteEnvValue(value: string): string {
    const needsQuotes = value.length === 0 || /[\s#"'\\]/.test(value);

    if (!needsQuotes) {
        return value;
    }

    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t");

    return `"${escaped}"`;
}

/** Options for {@link setEntry}. */
export interface SetEntryOptions {
    /**
     * Comment lines written above the entry when it is appended. An existing entry keeps whatever
     * is above it. Lines may be given with or without their leading `#`.
     */
    header?: string | readonly string[];
}

/** Turns header text into `#` comment lines. */
function headerLines(header: string | readonly string[]): string[] {
    const source = typeof header === "string" ? header.split("\n") : header;

    return source.map((line) => {
        const trimmed = line.trimEnd();

        if (trimmed.length === 0) {
            return "#";
        }

        return trimmed.startsWith("#") ? trimmed : `# ${trimmed}`;
    });
}

/**
 * Sets one variable in a line model, in place. An existing assignment is rewritten where it
 * stands, keeping its indentation, `export ` prefix and trailing comment; when the key appears more
 * than once, the last one is rewritten, since that is the one the parser honors. A new key is
 * appended under its header comment.
 */
export function setEntry(model: EnvFileModel, key: string, value: string, options: SetEntryOptions = {}): "updated" | "appended" {
    const quoted = quoteEnvValue(value);

    for (let i = model.lines.length - 1; i >= 0; i--) {
        const line = model.lines[i]!;

        if (line.kind !== "assignment" || line.key !== key) {
            continue;
        }

        const prefix = line.exported ? "export " : "";
        const text = `${line.indent}${prefix}${key}=${quoted}${line.inlineComment}`;

        model.lines[i] = { ...line, text, rawValue: quoted };

        return "updated";
    }

    // One blank line separates the new entry from what came before, unless the file is empty or
    // already ends with one.
    const last = model.lines[model.lines.length - 1];

    if (last !== undefined && last.kind !== "blank") {
        model.lines.push({ kind: "blank", text: "" });
    }

    if (options.header !== undefined) {
        for (const text of headerLines(options.header)) {
            model.lines.push({ kind: "comment", text });
        }
    }

    model.lines.push({ kind: "assignment", text: `${key}=${quoted}`, indent: "", exported: false, key, rawValue: quoted, inlineComment: "" });
    model.trailingNewline = true;

    return "appended";
}

/**
 * Removes every assignment of one variable, leaving comments and blank lines alone (sous does not
 * read comments, so it cannot know which belonged to the entry). Returns how many lines went.
 */
export function removeEntry(model: EnvFileModel, key: string): number {
    const before = model.lines.length;

    model.lines = model.lines.filter((line) => !(line.kind === "assignment" && line.key === key));

    return before - model.lines.length;
}

/** Reads an env file into a line model; an empty model when the file does not exist. */
export function readEnvFile(filePath: string): EnvFileModel {
    if (!fs.existsSync(filePath)) {
        return { lines: [], eol: "\n", trailingNewline: true };
    }

    return parseEnvFile(fs.readFileSync(filePath, "utf8"));
}

/** Reads one env file as a flat map; `{}` when it does not exist. */
export function readEnvFileMap(filePath: string): Record<string, string> {
    if (!fs.existsSync(filePath)) {
        return {};
    }

    return parseEnv(fs.readFileSync(filePath, "utf8"));
}

/**
 * Writes text over a file atomically: it goes to a temporary file in the same directory, renamed
 * over the original, so an interrupted write never leaves half a file. A new file is readable and
 * writable by its owner only (`.env.local` holds secrets); an existing file keeps its mode.
 */
export function writeFileAtomically(filePath: string, text: string, newMode = 0o600): void {
    const directory = path.dirname(filePath);

    fs.mkdirSync(directory, { recursive: true });

    const temporary = path.join(directory, `.${path.basename(filePath)}.sous-${process.pid}-${Date.now()}.tmp`);
    let mode = newMode;

    try {
        mode = fs.statSync(filePath).mode & 0o777;
    } catch {
        // No file yet, so the new-file mode stands.
    }

    try {
        fs.writeFileSync(temporary, text, { encoding: "utf8", mode });
        fs.renameSync(temporary, filePath);
    } catch (error) {
        fs.rmSync(temporary, { force: true });
        throw error;
    }
}

/** Writes a line model to disk atomically. */
export function writeEnvFile(filePath: string, model: EnvFileModel): void {
    writeFileAtomically(filePath, renderEnvFile(model));
}

/** Reads, edits and rewrites one env file: the usual way to store one value. */
export function updateEnvFile(filePath: string, key: string, value: string, options: SetEntryOptions = {}): "updated" | "appended" {
    const model = readEnvFile(filePath);
    const outcome = setEntry(model, key, value, options);

    writeEnvFile(filePath, model);

    return outcome;
}
