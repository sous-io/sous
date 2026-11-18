/**
 * The editor's thin layer over `@sous-io/documents`. The library does the work: it chooses a
 * file's format (`formatForPath`), parses JSON, JSONC, YAML and a Markdown file's frontmatter
 * (`parseDocument`), edits a plain text file as lines (`parseLines`), writes managed-block markers in
 * the file's comment style (`commentStyleForPath`), and keeps every byte an edit does not touch.
 *
 * What this file adds:
 *
 * - The editor's names for formats: the library's `lines` is `text` here, and a file the library
 *   does not know is `text` too, since the editor treats anything without a structure as lines.
 *   TOML is recognized and refused (`UnsupportedFormatError`), so a TOML file is skipped with a
 *   warning, as an unparseable file is, until the library edits it.
 * - One interface over both kinds of document, so a list operation can work on a plain text
 *   file's lines through nodes: the root of a `text` document is an array of strings.
 */

import {
    commentStyleForPath,
    createDocument,
    formatForPath,
    parseDocument,
    parseLines,
    type CommentStyle,
    type DocNode,
    type JsonValue,
    type LinesDocument,
    type PathInput,
    type TextDocument,
} from "@sous-io/documents";

/** The formats the editor knows, chosen from a file's name. */
export type EditorFormat = "json" | "jsonc" | "yaml" | "markdown" | "text" | "toml";

/**
 * One open document: its value as plain JSON, a node API over it, and its text with every edit
 * made surgically.
 */
export interface EditableDocument {
    readonly format: EditorFormat;
    /** The whole document, as a node. */
    root(): DocNode;
    /** A node at a path; `""` is the root. */
    atPath(path: PathInput): DocNode;
    /** The current value. */
    value(): JsonValue;
    /** The text, with every edit made. Unchanged documents give back their text byte for byte. */
    toString(): string;
}

/** A format the editor recognizes but cannot edit yet. */
export class UnsupportedFormatError extends Error {
    constructor(readonly format: EditorFormat) {
        super(`Sous cannot edit ${format.toUpperCase()} files yet.`);
        this.name = "UnsupportedFormatError";
    }
}

/**
 * The format of a file, from its name (the library's `formatForPath`).
 *
 * ```ts
 * formatForFile(".claude/settings.json");      // "json"
 * formatForFile(".vscode/settings.json");      // "jsonc"
 * formatForFile(".pre-commit-config.yaml");    // "yaml"
 * formatForFile(".claude/agents/review.md");   // "markdown"
 * formatForFile(".codex/config.toml");         // "toml"
 * formatForFile(".gitignore");                 // "text"
 * ```
 */
export function formatForFile(file: string): EditorFormat {
    const format = formatForPath(file);

    if (format === undefined) {
        return file.toLowerCase().endsWith(".toml") ? "toml" : "text";
    }

    return format === "lines" ? "text" : format;
}

/** How a file writes comments, for the marker lines of a managed block (the library's `commentStyleForPath`). */
export function commentStyleFor(file: string): CommentStyle {
    return commentStyleForPath(file);
}

/**
 * Opens text in a format. Empty text is an empty document: `{}` for JSON, JSONC, YAML and a
 * Markdown file's frontmatter, no lines for plain text.
 *
 * @throws Error when the text cannot be parsed, naming where.
 * @throws UnsupportedFormatError for TOML.
 */
export function openDocument(text: string, format: EditorFormat): EditableDocument {
    switch (format) {
        case "json":
        case "jsonc":
        case "yaml":
        case "markdown":
            return wrapTextDocument(parseDocument(text, format), format);
        case "text":
            return linesAsList(parseLines(text));
        case "toml":
            throw new UnsupportedFormatError(format);
    }
}

/**
 * The lines of a text (`""` has none; a final line break adds no empty line).
 *
 * ```ts
 * linesOfText("a\nb\n");   // ["a", "b"]
 * ```
 */
export function linesOfText(text: string): string[] {
    return parseLines(text).lines();
}

/** The library's text document, as an editable document. */
function wrapTextDocument(doc: TextDocument, format: EditorFormat): EditableDocument {
    return {
        format,
        root: () => doc.root(),
        atPath: (path) => doc.atPath(path),
        value: () => doc.value(),
        toString: () => doc.toString(),
    };
}

/**
 * A plain text file as a list of lines a node can edit. The text is the library's lines document
 * given the list's lines, so only the lines that changed are rewritten.
 */
function linesAsList(file: LinesDocument): EditableDocument {
    const doc = createDocument(file.lines());

    return {
        format: "text",
        root: () => doc.root(),
        atPath: (path) => doc.atPath(path),
        value: () => doc.value(),
        toString() {
            const value = doc.value();

            // An item holding a line break becomes as many lines.
            const lines = Array.isArray(value) ? value.flatMap((line) => (typeof line === "string" ? line : JSON.stringify(line)).split(/\r?\n/)) : [];

            file.setLines(lines);

            return file.toString();
        },
    };
}
