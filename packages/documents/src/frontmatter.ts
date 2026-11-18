/**
 * YAML frontmatter at the top of a Markdown file: the block between a first line `---` and the
 * next line `---` (or `...`).
 */

/** A Markdown text cut into its frontmatter and its body; `head + body` is the whole text. */
export interface FrontmatterParts {
    /** The whole frontmatter block, both marker lines included, or `""` when there is none. */
    head: string;
    /** The opening marker line with its line ending, or `undefined` when there is no frontmatter. */
    open: string | undefined;
    /** The YAML between the markers, or `undefined` when there is no frontmatter. */
    yaml: string | undefined;
    /** The closing marker line with its line ending (none when the file ends there), or `undefined`. */
    close: string | undefined;
    /** Everything after the frontmatter: the whole text when there is none. */
    body: string;
}

/**
 * Cuts a Markdown text into its frontmatter and its body. A text has frontmatter only when its
 * first line is `---` and a later line is `---` or `...`; an opening line with no closing line is
 * not frontmatter, and the whole text is the body.
 *
 * ```ts
 * splitFrontmatter("---\ntitle: Hi\n---\n# Hi\n");
 * // { head: "---\ntitle: Hi\n---\n", open: "---\n", yaml: "title: Hi\n", close: "---\n", body: "# Hi\n" }
 * ```
 */
export function splitFrontmatter(text: string): FrontmatterParts {
    const none: FrontmatterParts = { head: "", open: undefined, yaml: undefined, close: undefined, body: text };
    const open = /^﻿?---[ \t]*(\r?\n)/.exec(text);

    if (open === null) {
        return none;
    }

    const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;

    // With the `m` flag, `^` matches only at a line start, so the first match is the closing line.
    closing.lastIndex = open[0].length;

    const match = closing.exec(text);

    if (match === null) {
        return none;
    }

    const end = match.index + match[0].length;

    return {
        head: text.slice(0, end),
        open: open[0],
        yaml: text.slice(open[0].length, match.index),
        close: match[0],
        body: text.slice(end),
    };
}

/**
 * Puts a Markdown text back together with new frontmatter YAML, keeping the body byte for byte.
 * The markers already there are kept; a text with none gets `---` lines in its own line ending.
 * YAML that is empty (only whitespace) removes the block.
 *
 * ```ts
 * joinFrontmatter(splitFrontmatter("# Hi\n"), "title: Hi\n");   // "---\ntitle: Hi\n---\n# Hi\n"
 * ```
 */
export function joinFrontmatter(parts: FrontmatterParts, yaml: string): string {
    if (yaml.trim() === "") {
        return parts.body;
    }

    const eol = (parts.open ?? parts.body).includes("\r\n") ? "\r\n" : "\n";
    const open = parts.open ?? `---${eol}`;
    const close = parts.close ?? `---${eol}`;
    const content = yaml.endsWith("\n") ? yaml : yaml + eol;

    return `${open}${content}${close}${parts.body}`;
}
