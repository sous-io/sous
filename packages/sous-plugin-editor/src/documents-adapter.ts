/**
 * THE ADAPTER OVER `@sous-io/documents`. Everything the editor needs from the document library
 * goes through this one file, so the library's own formats can replace the stopgaps below when
 * they arrive.
 *
 * What the library gives today, and the editor uses as it is: `parseDocument(text, "json" |
 * "jsonc" | "yaml")`, its `DocNode` and paths. What it lacks today, and this file supplies in the
 * narrowest form that works:
 *
 * - **Plain text as a list of lines** (`text`): a `.gitignore`, a shell script, anything without a
 *   structured format. The root is an array of strings, one per line, so the list operations work
 *   on lines. Line endings and the final newline are kept.
 * - **YAML frontmatter inside a Markdown file** (`markdown`): the root is the frontmatter's
 *   mapping, edited through the library's YAML document; the body is kept byte for byte. A file
 *   with no frontmatter gains one only when an edit is made to it.
 * - **TOML** is recognized and refused (`UnsupportedFormatError`), so a TOML file is skipped with a
 *   warning, as an unparseable file is, until the library edits it.
 *
 * When the library ships `text` and `frontmatter` formats of its own, `openDocument` calls them
 * instead and the two classes below are deleted; nothing else in the editor changes.
 */

import { createDocument, deepEqual, parseDocument, type DocNode, type JsonValue, type PathInput, type TextDocument } from "@sous-io/documents";

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
 * The format of a file, from its name.
 *
 * ```ts
 * formatForFile(".claude/settings.json");      // "json"
 * formatForFile(".vscode/settings.jsonc");     // "jsonc"
 * formatForFile(".pre-commit-config.yaml");    // "yaml"
 * formatForFile(".claude/agents/review.md");   // "markdown"
 * formatForFile(".codex/config.toml");         // "toml"
 * formatForFile(".gitignore");                 // "text"
 * ```
 */
export function formatForFile(file: string): EditorFormat {
    const name = file.toLowerCase();

    if (name.endsWith(".json")) return "json";
    if (name.endsWith(".jsonc")) return "jsonc";
    if (name.endsWith(".yaml") || name.endsWith(".yml")) return "yaml";
    if (name.endsWith(".md") || name.endsWith(".markdown") || name.endsWith(".mdx")) return "markdown";
    if (name.endsWith(".toml")) return "toml";

    return "text";
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
            return wrapTextDocument(parseDocument(text, format), format);
        case "markdown":
            return new FrontmatterDocument(text);
        case "text":
            return new LinesDocument(text);
        case "toml":
            throw new UnsupportedFormatError(format);
    }
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

/** Splits text into lines, noting the line ending it uses and whether it ends with one. */
export function splitLines(text: string): { lines: string[]; eol: string; finalNewline: boolean } {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";

    if (text === "") {
        return { lines: [], eol, finalNewline: true };
    }

    const finalNewline = text.endsWith("\n");
    const body = finalNewline ? text.slice(0, text.endsWith("\r\n") ? -2 : -1) : text;

    return { lines: body.split(/\r?\n/), eol, finalNewline };
}

/** Joins lines with a line ending, with a final newline when asked. No lines is the empty string. */
export function joinLines(lines: readonly string[], eol: string, finalNewline: boolean): string {
    return lines.length === 0 ? "" : lines.join(eol) + (finalNewline ? eol : "");
}

/** A plain text file as a list of lines (a stopgap; see the file comment). */
class LinesDocument implements EditableDocument {
    readonly format = "text" as const;
    private readonly doc;
    private readonly original: string[];
    private readonly eol: string;
    private readonly finalNewline: boolean;

    constructor(private readonly text: string) {
        const split = splitLines(text);

        this.original = split.lines;
        this.eol = split.eol;
        this.finalNewline = split.finalNewline;
        this.doc = createDocument(split.lines);
    }

    root(): DocNode {
        return this.doc.root();
    }

    atPath(path: PathInput): DocNode {
        return this.doc.atPath(path);
    }

    value(): JsonValue {
        return this.doc.value();
    }

    toString(): string {
        const value = this.doc.value();

        if (deepEqual(value, this.original)) {
            return this.text;
        }

        const lines = Array.isArray(value) ? value.map((line) => (typeof line === "string" ? line : JSON.stringify(line))) : [];

        return joinLines(lines, this.eol, this.finalNewline);
    }
}

/** Frontmatter: `---`, YAML, `---`, at the very start of a file. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)^---[ \t]*(\r?\n|$)/m;

/** A Markdown file whose frontmatter is the document (a stopgap; see the file comment). */
class FrontmatterDocument implements EditableDocument {
    readonly format = "markdown" as const;
    private readonly yaml: TextDocument;
    private readonly yamlText: string;
    private readonly body: string;
    private readonly eol: string;

    constructor(private readonly text: string) {
        const match = text.startsWith("---") ? FRONTMATTER.exec(text) : null;

        this.eol = text.includes("\r\n") ? "\r\n" : "\n";

        if (match && match.index === 0) {
            this.yamlText = match[1]!;
            this.body = text.slice(match[0].length);
        } else {
            this.yamlText = "";
            this.body = text;
        }

        this.yaml = parseDocument(this.yamlText, "yaml");
    }

    root(): DocNode {
        return this.yaml.root();
    }

    atPath(path: PathInput): DocNode {
        return this.yaml.atPath(path);
    }

    value(): JsonValue {
        return this.yaml.value();
    }

    toString(): string {
        const yamlText = this.yaml.toString();

        if (yamlText === this.yamlText) {
            return this.text;
        }

        const block = yamlText.endsWith("\n") ? yamlText : `${yamlText}\n`;

        return `---${this.eol}${block}---${this.eol}${this.body}`;
    }
}
