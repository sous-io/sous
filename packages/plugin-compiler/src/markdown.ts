/**
 * Where an `@` reference may stand in a Markdown file: a small block-and-inline scanner that finds
 * the text Claude Code scans for imports, and the `@` references in it.
 *
 * Claude Code reads a memory file with a Markdown parser and scans only its text: not code spans,
 * fenced or indented code blocks, HTML blocks, HTML comments, frontmatter at the top of the file,
 * link destinations or image text. Inside a block, every piece of text between two pieces of inline
 * syntax (a code span, a tag, an escape, a bracket of a link, a mark of emphasis) is a text of its
 * own, so an `@` right after one of them counts as the start of a text.
 *
 * Sous needs the offsets of every reference, to put the file in its place, so it reads the
 * structure itself rather than through a parser library, whose tokens do not say where in the
 * source they stand (list items and quotes lose their indentation and markers).
 *
 * ```ts
 * const layout = scanMarkdown("See @a.md and `@b.md`.\n");
 * findImportTokens("See @a.md and `@b.md`.\n", layout.runs);
 * // [{ at: 4, end: 9, run: "a.md" }]: the code span is not scanned
 * ```
 */

import { IMPORT_TOKEN_PATTERN } from "./paths.js";

/** A run of text that is scanned for `@` references. */
export interface TextRun {
    readonly start: number;
    readonly end: number;
    /**
     * The text that comes right before the run as Claude Code reads it: `""` when the run starts a
     * text, so an `@` at its start counts.
     */
    readonly before: string;
}

/** A line that holds only `@` and one word, at the first column, claimed whole. */
export interface ClaimedLine {
    /** The offset of the `@`, which is the line's start. */
    readonly start: number;
    /** The end of the line's word, before trailing whitespace. */
    readonly end: number;
    /** The offset after the line's end of line, or the end of the text. */
    readonly next: number;
    /** The word after the `@`. */
    readonly word: string;
}

/** What scanning a file gives. */
export interface MarkdownLayout {
    /** Where the body starts: after the frontmatter at the top, or 0 when there is none. */
    readonly bodyStart: number;
    /** The text scanned for `@` references, in order. */
    readonly runs: TextRun[];
    /** The lines the caller claimed, in order. Their text is not in {@link runs}. */
    readonly claimed: ClaimedLine[];
}

/** How to scan. */
export interface ScanOptions {
    /**
     * Claims a line that holds only `@` and one word, at the first column, in Markdown text: the
     * line is then not scanned, and is listed in {@link MarkdownLayout.claimed}. Sous claims the
     * lines that hold its own include forms.
     */
    readonly claimLine?: (word: string) => boolean;
}

/** One `@` reference found in a run. */
export interface ImportToken {
    /** The offset of the `@`. */
    readonly at: number;
    /** The offset after the reference. */
    readonly end: number;
    /** The characters after the `@`, as written: not yet cut at `#`. */
    readonly run: string;
}

interface Range {
    start: number;
    end: number;
}

interface Line {
    readonly start: number;
    /** The end of the line's text, before `\r\n` or `\n`. */
    readonly end: number;
    /** The start of the next line. */
    readonly next: number;
}

/** A block of inline text: one paragraph or heading. */
interface InlineBlock {
    readonly start: number;
    end: number;
    /** Container markers inside the block (`>` of a quote on a later line), not text. */
    readonly prefixes: Range[];
}

/** How an HTML block ends: at a line holding a pattern, or at a blank line. */
interface HtmlBlock {
    readonly end: RegExp | null;
    readonly comment: boolean;
    readonly start: number;
}

/** The kinds of HTML block, in CommonMark's order. Kind 7 cannot interrupt a paragraph. */
const HTML_BLOCKS: readonly { start: RegExp; end: RegExp | null; comment?: true; interrupts?: false }[] = [
    { start: /^<(?:script|pre|style|textarea)(?:\s|>|$)/i, end: /<\/(?:script|pre|style|textarea)>/i },
    { start: /^<!--/, end: /-->/, comment: true },
    { start: /^<\?/, end: /\?>/ },
    { start: /^<![A-Za-z]/, end: />/ },
    { start: /^<!\[CDATA\[/, end: /\]\]>/ },
    {
        start: /^<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>|$)/i,
        end: null,
    },
    {
        start: /^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$/,
        end: null,
        interrupts: false,
    },
];

/** Inline HTML and autolinks, none of which is scanned. */
const INLINE_HTML: readonly RegExp[] = [
    /<!--[\s\S]*?-->/y,
    /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/y,
    /<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>/y,
    /<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>/y,
    /<\/[A-Za-z][A-Za-z0-9-]*\s*>/y,
    /<\?[\s\S]*?\?>/y,
    /<!\[CDATA\[[\s\S]*?\]\]>/y,
    /<![A-Za-z][^>]*>/y,
];

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;
const PUNCTUATION = /[\p{P}\p{S}]/u;
const WHITESPACE = /\s/;
const FENCE_OPEN = /^(`{3,}|~{3,})(.*)$/;
const THEMATIC_BREAK = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const ATX_HEADING = /^#{1,6}(?=[ \t]|$)/;
const LIST_MARKER = /^(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$)/;
const LINK_DEFINITION = /^\[(?:[^\]\\]|\\.)+\]:/;
const CLAIMABLE_LINE = /^@(\S+)[ \t]*$/;

/**
 * Where the frontmatter at the top of a text ends: after a closing `---` (or `...`) line, when the
 * text starts with a `---` line. 0 when there is none.
 *
 * ```ts
 * frontmatterEnd("---\ntitle: x\n---\nBody\n"); // 17
 * frontmatterEnd("Body\n");                     // 0
 * ```
 */
export function frontmatterEnd(text: string): number {
    const open = /^---[ \t]*\r?\n/.exec(text);

    if (open === null) {
        return 0;
    }

    for (const line of linesOf(text, open[0].length)) {
        if (/^(?:---|\.\.\.)[ \t]*$/.test(text.slice(line.start, line.end))) {
            return line.next;
        }
    }

    return 0;
}

/** A text without the frontmatter at its top. */
export function stripFrontmatter(text: string): string {
    return text.slice(frontmatterEnd(text));
}

/**
 * Reads the structure of a Markdown text: which parts of it Claude Code scans for imports, and
 * which lines the caller claims whole.
 */
export function scanMarkdown(text: string, options: ScanOptions = {}): MarkdownLayout {
    const bodyStart = frontmatterEnd(text);
    const runs: TextRun[] = [];
    const claimed: ClaimedLine[] = [];
    const listIndents: number[] = [];
    let block: InlineBlock | null = null;
    // A paragraph is open: an indented line continues it instead of starting a code block.
    let paragraphOpen = false;
    let fence: { char: string; length: number } | null = null;
    let html: HtmlBlock | null = null;

    const flush = (): void => {
        if (block !== null) {
            runs.push(...inlineRuns(text, block));
            block = null;
        }
    };

    for (const line of linesOf(text, bodyStart)) {
        const raw = text.slice(line.start, line.end);

        if (fence !== null) {
            const close = stripContainers(text, line).content.trimStart();

            if (close.startsWith(fence.char.repeat(fence.length)) && new RegExp(`^\\${fence.char}+[ \\t]*$`).test(close)) {
                fence = null;
            }

            continue;
        }

        if (html !== null) {
            if (html.end === null) {
                if (raw.trim() === "") {
                    html = null;
                    paragraphOpen = false;
                }
            } else if (html.end.test(raw)) {
                if (html.comment) {
                    runs.push(...commentRemainder(text, html.start, line.end));
                }

                html = null;
            }

            continue;
        }

        if (raw.trim() === "") {
            flush();
            paragraphOpen = false;
            continue;
        }

        const indent = indentWidth(raw);

        if (!paragraphOpen) {
            while (listIndents.length > 0 && indent < listIndents[listIndents.length - 1]!) {
                listIndents.pop();
            }
        }

        const base = listIndents.length > 0 && indent >= listIndents[listIndents.length - 1]! ? listIndents[listIndents.length - 1]! : 0;

        // An indented code block, which cannot interrupt a paragraph.
        if (indent - base >= 4 && !paragraphOpen) {
            flush();
            continue;
        }

        const { content, contentStart, quoted } = stripContainers(text, line);

        if (FENCE_OPEN.test(content) && !(content.startsWith("`") && FENCE_OPEN.exec(content)![2]!.includes("`"))) {
            const marker = FENCE_OPEN.exec(content)![1]!;

            flush();
            paragraphOpen = false;
            fence = { char: marker[0]!, length: marker.length };
            continue;
        }

        const htmlKind = HTML_BLOCKS.find((kind) => kind.start.test(content) && (kind.interrupts !== false || !paragraphOpen));

        if (htmlKind !== undefined) {
            flush();
            paragraphOpen = false;

            const opened: HtmlBlock = { end: htmlKind.end, comment: htmlKind.comment === true, start: line.start };
            const rest = htmlKind.comment === true ? content.slice(4) : content;

            if (opened.end !== null && opened.end.test(rest)) {
                if (opened.comment) {
                    runs.push(...commentRemainder(text, line.start, line.end));
                }
            } else {
                html = opened;
            }

            continue;
        }

        if (!paragraphOpen && LINK_DEFINITION.test(content)) {
            continue;
        }

        if (THEMATIC_BREAK.test(content.trimEnd())) {
            flush();
            paragraphOpen = false;
            continue;
        }

        const heading = ATX_HEADING.exec(content);

        if (heading !== null) {
            flush();
            runs.push(...inlineRuns(text, { start: contentStart + heading[0].length, end: line.end, prefixes: [] }));
            paragraphOpen = false;
            continue;
        }

        const claim = contentStart === line.start ? CLAIMABLE_LINE.exec(raw) : null;

        if (claim !== null && options.claimLine?.(claim[1]!) === true) {
            flush();
            claimed.push({ start: line.start, end: line.start + 1 + claim[1]!.length, next: line.next, word: claim[1]! });
            paragraphOpen = true;
            continue;
        }

        const item = LIST_MARKER.exec(content);

        if (item !== null) {
            const markerColumn = indent + (contentStart - line.start - leadingWhitespace(raw).length);
            const spacing = leadingWhitespace(content.slice(item[0].length)).length;
            const contentIndent = markerColumn + item[0].length + (spacing === 0 || spacing > 4 ? 1 : spacing);

            while (listIndents.length > 0 && listIndents[listIndents.length - 1]! > markerColumn) {
                listIndents.pop();
            }

            listIndents.push(contentIndent);
            flush();
            block = { start: contentStart + item[0].length, end: line.end, prefixes: [] };
            paragraphOpen = true;
            continue;
        }

        if (block === null) {
            block = { start: contentStart, end: line.end, prefixes: [] };
        } else {
            if (quoted) {
                block.prefixes.push({ start: line.start, end: contentStart });
            }

            block.end = line.end;
        }

        paragraphOpen = true;
    }

    flush();

    return { bodyStart, runs, claimed };
}

/**
 * Every `@` reference Claude Code's rule finds in the runs, in order.
 *
 * ```ts
 * findImportTokens("a @x.md b", [{ start: 0, end: 9, before: "" }]);
 * // [{ at: 2, end: 7, run: "x.md" }]
 * ```
 */
export function findImportTokens(text: string, runs: readonly TextRun[]): ImportToken[] {
    const tokens: ImportToken[] = [];

    for (const run of runs) {
        const scanned = run.before + text.slice(run.start, run.end);
        const pattern = new RegExp(IMPORT_TOKEN_PATTERN.source, "g");
        let match: RegExpExecArray | null;

        while ((match = pattern.exec(scanned)) !== null) {
            const found = match[1]!;
            const at = run.start - run.before.length + match.index + match[0].length - found.length - 1;

            tokens.push({ at, end: at + 1 + found.length, run: found });
        }
    }

    return tokens.sort((left, right) => left.at - right.at);
}

/** The lines of a text from an offset. */
function* linesOf(text: string, from: number): Generator<Line> {
    let start = from;

    while (start < text.length) {
        const newline = text.indexOf("\n", start);
        const next = newline === -1 ? text.length : newline + 1;
        let end = newline === -1 ? text.length : newline;

        if (end > start && text[end - 1] === "\r") {
            end -= 1;
        }

        yield { start, end, next };
        start = next;
    }
}

function leadingWhitespace(value: string): string {
    return /^[ \t]*/.exec(value)![0];
}

/** The width of a line's indentation, a tab reaching the next multiple of four. */
function indentWidth(raw: string): number {
    let width = 0;

    for (const char of leadingWhitespace(raw)) {
        width = char === "\t" ? width + 4 - (width % 4) : width + 1;
    }

    return width;
}

/** A line without its indentation and the `>` markers of quotes. */
function stripContainers(text: string, line: Line): { content: string; contentStart: number; quoted: boolean } {
    let position = line.start + leadingWhitespace(text.slice(line.start, line.end)).length;
    let quoted = false;

    while (position < line.end && text[position] === ">") {
        quoted = true;
        position += 1;

        if (text[position] === " " || text[position] === "\t") {
            position += 1;
        }

        position += leadingWhitespace(text.slice(position, line.end)).length;
    }

    return { content: text.slice(position, line.end), contentStart: position, quoted };
}

/**
 * The text of an HTML block that begins with a comment, with every comment taken out. Claude Code
 * scans what is left as one text, so each piece is preceded by the one before it.
 */
function commentRemainder(text: string, start: number, end: number): TextRun[] {
    const runs: TextRun[] = [];
    const comment = /<!--[\s\S]*?-->/g;
    let position = start;
    let before = "";
    let match: RegExpExecArray | null;

    const piece = (pieceEnd: number): void => {
        if (pieceEnd > position) {
            runs.push({ start: position, end: pieceEnd, before });
            before = text[pieceEnd - 1]!;
        }
    };

    comment.lastIndex = start;

    while ((match = comment.exec(text)) !== null && match.index < end) {
        piece(match.index);
        position = Math.min(match.index + match[0].length, end);
    }

    piece(end);

    return runs;
}

/** A mark of emphasis: a run of `*` or `_`. */
interface Delimiter {
    readonly char: string;
    start: number;
    end: number;
    readonly length: number;
    readonly canOpen: boolean;
    readonly canClose: boolean;
    active: boolean;
}

/**
 * The runs of text inside one paragraph or heading: the block minus code spans, inline HTML,
 * autolinks, escapes, images, link destinations, the brackets of links and the marks of emphasis.
 */
function inlineRuns(text: string, block: InlineBlock): TextRun[] {
    const { start, end } = block;
    const skipped: Range[] = [...block.prefixes];
    const tails = new Map<number, number>();
    const delimiters: Delimiter[] = [];
    const prefixAt = new Map(block.prefixes.map((range) => [range.start, range.end]));
    let index = start;

    while (index < end) {
        const prefixEnd = prefixAt.get(index) ?? tails.get(index);

        if (prefixEnd !== undefined) {
            if (tails.has(index)) {
                skipped.push({ start: index, end: prefixEnd });
            }

            index = prefixEnd;
            continue;
        }

        const char = text[index]!;

        if (char === "\\" && index + 1 < end && ASCII_PUNCTUATION.test(text[index + 1]!)) {
            skipped.push({ start: index, end: index + 2 });
            index += 2;
            continue;
        }

        if (char === "`") {
            const span = codeSpanEnd(text, index, end);

            if (span.close !== -1) {
                skipped.push({ start: index, end: span.close });
            }

            index = span.close !== -1 ? span.close : index + span.length;
            continue;
        }

        if (char === "<") {
            const tagEnd = inlineHtmlEnd(text, index, end);

            if (tagEnd !== -1) {
                skipped.push({ start: index, end: tagEnd });
                index = tagEnd;
                continue;
            }
        }

        if (char === "!" && text[index + 1] === "[") {
            const link = linkAt(text, index + 1, end);

            if (link !== null) {
                skipped.push({ start: index, end: link.end });
                index = link.end;
                continue;
            }
        }

        if (char === "[") {
            const link = linkAt(text, index, end);

            if (link !== null) {
                skipped.push({ start: index, end: index + 1 });
                tails.set(link.textEnd, link.end);
            }
        }

        if (char === "*" || char === "_") {
            let runEnd = index;

            while (runEnd < end && text[runEnd] === char) {
                runEnd += 1;
            }

            delimiters.push(delimiter(text, char, index, runEnd, start, end));
            index = runEnd;
            continue;
        }

        index += 1;
    }

    skipped.push(...matchEmphasis(delimiters));

    return gaps(start, end, skipped).map((range) => ({ ...range, before: "" }));
}

/** Where a code span that opens at `index` ends, or -1 when its backticks are literal. */
function codeSpanEnd(text: string, index: number, end: number): { close: number; length: number } {
    let length = 0;

    while (index + length < end && text[index + length] === "`") {
        length += 1;
    }

    let position = index + length;

    while (position < end) {
        if (text[position] !== "`") {
            position += 1;
            continue;
        }

        let run = 0;

        while (position + run < end && text[position + run] === "`") {
            run += 1;
        }

        if (run === length) {
            return { close: position + run, length };
        }

        position += run;
    }

    return { close: -1, length };
}

/** Where inline HTML or an autolink that starts at `index` ends, or -1. */
function inlineHtmlEnd(text: string, index: number, end: number): number {
    for (const pattern of INLINE_HTML) {
        pattern.lastIndex = index;

        const match = pattern.exec(text);

        if (match !== null && index + match[0].length <= end) {
            return index + match[0].length;
        }
    }

    return -1;
}

/**
 * A link whose text opens with the `[` at `index`: where its text ends (the `]`) and where the
 * whole link ends. Only an inline link (`[text](destination)`) or a full reference link
 * (`[text][label]`) counts; a lone `[text]` is text.
 */
function linkAt(text: string, index: number, end: number): { textEnd: number; end: number } | null {
    const textEnd = closingBracket(text, index, end, "[", "]");

    if (textEnd === -1) {
        return null;
    }

    const after = text[textEnd + 1];

    if (after === "(") {
        const close = closingBracket(text, textEnd + 1, end, "(", ")");

        return close === -1 ? null : { textEnd, end: close + 1 };
    }

    if (after === "[") {
        const close = closingBracket(text, textEnd + 1, end, "[", "]");

        return close === -1 ? null : { textEnd, end: close + 1 };
    }

    return null;
}

/** The offset of the bracket that closes the one at `index`, skipping escapes and code spans; -1 when none. */
function closingBracket(text: string, index: number, end: number, open: string, close: string): number {
    let depth = 0;
    let position = index;

    while (position < end) {
        const char = text[position]!;

        if (char === "\\") {
            position += 2;
            continue;
        }

        if (char === "`") {
            const span = codeSpanEnd(text, position, end);

            position = span.close !== -1 ? span.close : position + span.length;
            continue;
        }

        if (char === open) {
            depth += 1;
        } else if (char === close) {
            depth -= 1;

            if (depth === 0) {
                return position;
            }
        }

        position += 1;
    }

    return -1;
}

/** A run of `*` or `_` and whether it can open or close emphasis (CommonMark's flanking rules). */
function delimiter(text: string, char: string, start: number, end: number, blockStart: number, blockEnd: number): Delimiter {
    const before = start === blockStart ? " " : text[start - 1]!;
    const after = end >= blockEnd ? " " : text[end]!;
    const left = !WHITESPACE.test(after) && (!PUNCTUATION.test(after) || WHITESPACE.test(before) || PUNCTUATION.test(before));
    const right = !WHITESPACE.test(before) && (!PUNCTUATION.test(before) || WHITESPACE.test(after) || PUNCTUATION.test(after));
    const canOpen = char === "*" ? left : left && (!right || PUNCTUATION.test(before));
    const canClose = char === "*" ? right : right && (!left || PUNCTUATION.test(after));

    return { char, start, end, length: end - start, canOpen, canClose, active: true };
}

/** The characters of every mark of emphasis that pairs with another, by CommonMark's rules. */
function matchEmphasis(delimiters: Delimiter[]): Range[] {
    const used: Range[] = [];

    for (let closerIndex = 0; closerIndex < delimiters.length; closerIndex += 1) {
        const closer = delimiters[closerIndex]!;

        while (closer.canClose && closer.end > closer.start) {
            let openerIndex = closerIndex - 1;

            for (; openerIndex >= 0; openerIndex -= 1) {
                const opener = delimiters[openerIndex]!;

                if (!opener.active || opener.char !== closer.char || !opener.canOpen || opener.end === opener.start) {
                    continue;
                }

                const oddMatch =
                    (opener.canClose || closer.canOpen) && (opener.length + closer.length) % 3 === 0 && !(opener.length % 3 === 0 && closer.length % 3 === 0);

                if (!oddMatch) {
                    break;
                }
            }

            if (openerIndex < 0) {
                break;
            }

            const opener = delimiters[openerIndex]!;
            const count = opener.end - opener.start >= 2 && closer.end - closer.start >= 2 ? 2 : 1;

            used.push({ start: opener.end - count, end: opener.end }, { start: closer.start, end: closer.start + count });
            opener.end -= count;
            closer.start += count;

            for (let between = openerIndex + 1; between < closerIndex; between += 1) {
                delimiters[between]!.active = false;
            }
        }
    }

    return used;
}

/** The parts of `[start, end)` no range covers. */
function gaps(start: number, end: number, ranges: Range[]): Range[] {
    const out: Range[] = [];
    let position = start;

    for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
        if (range.start > position) {
            out.push({ start: position, end: Math.min(range.start, end) });
        }

        position = Math.max(position, range.end);
    }

    if (position < end) {
        out.push({ start: position, end });
    }

    return out.filter((range) => range.end > range.start);
}
