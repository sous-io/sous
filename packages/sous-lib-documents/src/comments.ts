/**
 * Comments attached to one key or list item of a JSONC or YAML text: the comment lines directly
 * above it ("before") and the comment at the end of its line ("after"). Reading, setting,
 * replacing and removing them is surgical: only the comment's own bytes change, the line endings
 * are the file's, and new comment lines take the node's indentation.
 *
 * ```yaml
 * # The model the reviewer runs on      <- before `model`
 * model: opus # the newest one           <- after `model`
 * ```
 *
 * Plain JSON has no comments, so every function here refuses a `json` text with a
 * {@link CommentError}. The YAML frontmatter of a Markdown file is handled by
 * {@link TextDocument}, which hands this module the frontmatter's YAML.
 */
import { createScanner, findNodeAtLocation, parse, parseTree, type Node as JsonNode } from "jsonc-parser";
import { CST, isAlias, isMap, isSeq, Lexer, parseDocument as parseYamlModel, type Pair, type ParsedNode } from "yaml";
import { deepEqual } from "./json.js";
import { formatPath, parsePath } from "./path.js";
import type { JsonValue, PathInput, PathSegment } from "./types.js";

/** Where a comment sits: on its own lines directly above the node, or at the end of the node's line. */
export type CommentPlace = "before" | "after";

/** The formats this module edits comments in: JSON is refused, Markdown frontmatter is YAML. */
export type CommentFormat = "json" | "jsonc" | "yaml";

/** A comment that cannot be read or written where it was asked for. */
export class CommentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CommentError";
    }
}

/** One comment in the text: `# x`, `// x` or `/* x *\/`. */
interface Span {
    offset: number;
    end: number;
    block: boolean;
}

/** Everything about one node's comments, found once. */
interface CommentSite {
    eol: string;
    /** The whitespace that starts the node's line, which new comment lines take. */
    indent: string;
    /** Where the node's first line starts. */
    lineStart: number;
    /** The comment lines above: from `before.from` to `lineStart`. Empty when `from === lineStart`. */
    before: { from: number; comments: Span[] };
    /** The tail of the node's line: from the end of its content to the end of the line, spaces included. */
    after: { from: number; to: number; comment: Span | undefined };
    yaml: boolean;
}

/**
 * The words of the comment before or after a node, markers taken off and lines joined with
 * `\n`, or `undefined` when it has none.
 *
 * ```ts
 * readComment("# The model\nmodel: opus # newest\n", "yaml", "model", "before");   // "The model"
 * readComment("# The model\nmodel: opus # newest\n", "yaml", "model", "after");    // "newest"
 * ```
 *
 * @throws CommentError for JSON, a path with no key or list item, or a node that shares its line.
 */
export function readComment(text: string, format: CommentFormat, path: PathInput, place: CommentPlace): string | undefined {
    const site = locate(text, format, path);
    const spans = place === "before" ? site.before.comments : site.after.comment === undefined ? [] : [site.after.comment];

    return spans.length === 0 ? undefined : spans.map((span) => words(text.slice(span.offset, span.end), span.block)).join("\n");
}

/**
 * The comment before or after a node exactly as written, so it can be put back byte for byte
 * with {@link restoreCommentSource}. Before: its whole lines, line endings included (`""` when
 * there is none). After: everything from the end of the node's content to the end of its line,
 * the spaces and the comment (`""`, or the line's trailing spaces, when there is none).
 */
export function commentSource(text: string, format: CommentFormat, path: PathInput, place: CommentPlace): string {
    const site = locate(text, format, path);

    return place === "before" ? text.slice(site.before.from, site.lineStart) : text.slice(site.after.from, site.after.to);
}

/**
 * Sets the comment before or after a node: replaces the one there, or adds one. A comment before
 * may have several lines (`\n` between them); a comment after is one line.
 *
 * ```ts
 * setComment("model: opus\n", "yaml", "model", "before", "The model");   // "# The model\nmodel: opus\n"
 * setComment("model: opus\n", "yaml", "model", "after", "newest");       // "model: opus # newest\n"
 * ```
 *
 * @throws CommentError when the comment cannot be put there without changing a value.
 */
export function setComment(text: string, format: CommentFormat, path: PathInput, place: CommentPlace, comment: string): string {
    const site = locate(text, format, path);
    const lines = comment.split(/\r?\n/);
    let result: string;

    if (place === "before") {
        const block = site.before.comments.length === 1 && site.before.comments[0]!.block;
        const rendered = renderBefore(lines, site, block);

        result = replace(text, site.before.from, site.lineStart, rendered);
    } else {
        if (lines.length > 1) {
            throw new CommentError(`A comment after ${where(path)} is one line; this one has ${lines.length}.`);
        }

        const existing = site.after.comment;
        const marker = renderMarker(lines[0]!, site.yaml, existing?.block === true);

        result = existing === undefined
            ? replace(text, site.after.from, site.after.to, ` ${marker}`)
            : replace(text, existing.offset, existing.end, marker);
    }

    verify(text, result, format, path, place, normalize(comment));

    return result;
}

/**
 * Removes the comment before or after a node: its lines, or the comment and the spaces before
 * it. Text with no such comment is returned as it is.
 */
export function removeComment(text: string, format: CommentFormat, path: PathInput, place: CommentPlace): string {
    const site = locate(text, format, path);
    let result: string;

    if (place === "before") {
        result = replace(text, site.before.from, site.lineStart, "");
    } else if (site.after.comment === undefined) {
        return text;
    } else {
        result = replace(text, site.after.from, site.after.to, "");
    }

    verify(text, result, format, path, place, undefined);

    return result;
}

/**
 * Puts back what {@link commentSource} returned, byte for byte, in place of the comment there now.
 */
export function restoreCommentSource(text: string, format: CommentFormat, path: PathInput, place: CommentPlace, source: string): string {
    const site = locate(text, format, path);
    const result = place === "before"
        ? replace(text, site.before.from, site.lineStart, source)
        : replace(text, site.after.from, site.after.to, source);

    verify(text, result, format, path, place, null);

    return result;
}

/**
 * A function giving where the comment "before" a line starts: the first of the comment lines
 * directly above it at its indentation, with no blank line between (the definition every other
 * function here uses), or the line's own start when it has none. The text's comments are found
 * once, so a caller can ask about every key of an object cheaply.
 *
 * ```ts
 * const above = commentLinesAbove("a: 1\n# about b\nb: 2\n", "yaml");
 *
 * above(14);   // 5: "# about b" belongs to `b`, whose line starts at 14
 * above(0);    // 0: `a` has no comment above it
 * ```
 */
export function commentLinesAbove(text: string, format: "jsonc" | "yaml"): (lineStart: number) => number {
    const comments = format === "yaml" ? yamlComments(text) : jsoncComments(text);

    return (lineStart) => {
        const indent = /^[ \t]*/.exec(text.slice(lineStart))![0];

        return commentsAbove(text, comments, lineStart, indent).from;
    };
}

// Finding a node and its comments.

function where(path: PathInput): string {
    const formatted = formatPath(parsePath(path));

    return formatted === "" ? "the root" : formatted;
}

function locate(text: string, format: CommentFormat, input: PathInput): CommentSite {
    if (format === "json") {
        throw new CommentError("Plain JSON has no comments, so Sous cannot read or write one. Name the file .jsonc to allow them.");
    }

    const path = parsePath(input);

    if (path.length === 0) {
        throw new CommentError("A comment belongs to a key or a list item, so it needs a path; the root has none.");
    }

    const yaml = format === "yaml";
    const found = yaml ? locateYaml(text, path) : locateJsonc(text, path);
    const lineStart = lineStartOf(text, found.start);
    const lead = text.slice(lineStart, found.start);

    if (!(yaml ? /^[ \t]*(?:-[ \t]+)*$/ : /^[ \t]*$/).test(lead) || found.sharesLine) {
        throw new CommentError(`${where(path)} shares its line with other values, so it has no comment of its own.`);
    }

    const comments = yaml ? yamlComments(text) : jsoncComments(text);
    const indent = /^[ \t]*/.exec(lead)![0];
    const eol = text.includes("\r\n") ? "\r\n" : "\n";

    return {
        eol,
        indent,
        lineStart,
        before: commentsAbove(text, comments, lineStart, indent),
        after: lineTail(text, comments, found.start),
        yaml,
    };
}

/** Where a node's key or dash starts, and whether a sibling starts on the same line. */
interface Found {
    start: number;
    sharesLine: boolean;
}

function locateYaml(text: string, path: PathSegment[]): Found {
    const doc = parseYamlModel(text);

    if (doc.errors.length > 0) {
        throw new CommentError(`The YAML text is not valid: ${doc.errors[0]!.message}`);
    }

    let node = doc.contents as ParsedNode | null;
    let start = -1;

    for (const [depth, segment] of path.entries()) {
        const here = formatPath(path.slice(0, depth + 1));

        if (isAlias(node)) {
            throw new CommentError(`${here} is reached through a YAML alias (*name), so its comment cannot be placed in one spot.`);
        }

        if ((isMap(node) || isSeq(node)) && node.flow) {
            throw new CommentError(`${here} is inside a flow collection ([...] or {...}), which shares its line with other values.`);
        }

        if (isMap(node)) {
            const pair = (node.items as Pair<ParsedNode, ParsedNode | null>[]).find((item) => String((item.key as { value?: unknown })?.value ?? item.key) === String(segment));

            if (pair === undefined || pair.key?.range === undefined) {
                throw new CommentError(`There is no value at ${here}.`);
            }

            start = pair.key.range[0];
            node = pair.value;
        } else if (isSeq(node) && typeof segment === "number") {
            const item = node.items[segment] as ParsedNode | null | undefined;

            if (item === undefined || item === null) {
                throw new CommentError(`There is no value at ${here}.`);
            }

            let at = item.range[0] - 1;

            while (at >= 0 && (text[at] === " " || text[at] === "\t")) {
                at--;
            }

            if (text[at] !== "-") {
                throw new CommentError(`${here} does not start on its dash's line, so Sous cannot tell where its comment goes.`);
            }

            start = at;
            node = item;
        } else {
            throw new CommentError(`There is no value at ${here}.`);
        }
    }

    return { start, sharesLine: false };
}

function locateJsonc(text: string, path: PathSegment[]): Found {
    const tree = parseTree(text, [], { allowTrailingComma: true });
    const node = tree === undefined ? undefined : findNodeAtLocation(tree, path);

    if (node === undefined) {
        throw new CommentError(`There is no value at ${where(path)}.`);
    }

    const entry: JsonNode = typeof path[path.length - 1] === "string" ? node.parent! : node;
    const lineStart = lineStartOf(text, entry.offset);
    const lineEnd = lineEndOf(text, entry.offset);
    const sharesLine = (entry.parent?.children ?? []).some((sibling) => sibling !== entry && sibling.offset >= lineStart && sibling.offset < lineEnd);

    return { start: entry.offset, sharesLine };
}

/** Every comment of a YAML text, from the `yaml` package's lexer, so `#` inside quotes is not one. */
function yamlComments(text: string): Span[] {
    const spans: Span[] = [];
    let offset = 0;

    for (const token of new Lexer().lex(text)) {
        // The lexer's control tokens mark structure and are not in the text.
        if (token === "\u0002" || token === "\u0018" || token === "\u001f") {
            continue;
        }

        if (CST.tokenType(token) === "comment") {
            spans.push({ offset, end: trimEnd(text, offset, offset + token.length), block: false });
        }

        offset += token.length;
    }

    return spans;
}

/** A comment's end with the spaces (and a stray `\r`) after it left out, so it compares with a line's content end. */
function trimEnd(text: string, offset: number, end: number): number {
    let at = end;

    while (at > offset && (text[at - 1] === " " || text[at - 1] === "\t" || text[at - 1] === "\r")) {
        at--;
    }

    return at;
}

/** Every comment of a JSONC text, from jsonc-parser's scanner. */
function jsoncComments(text: string): Span[] {
    const LINE_COMMENT = 12;
    const BLOCK_COMMENT = 13;
    const EOF = 17;
    const scanner = createScanner(text, false);
    const spans: Span[] = [];

    for (let kind = scanner.scan(); kind !== EOF; kind = scanner.scan()) {
        if (kind === LINE_COMMENT || kind === BLOCK_COMMENT) {
            const offset = scanner.getTokenOffset();

            spans.push({ offset, end: trimEnd(text, offset, offset + scanner.getTokenLength()), block: kind === BLOCK_COMMENT });
        }
    }

    return spans;
}

/**
 * The comments directly above a line: each on lines of its own, starting at the same
 * indentation, with no blank line between them and the node.
 */
function commentsAbove(text: string, comments: Span[], lineStart: number, indent: string): CommentSite["before"] {
    const found: Span[] = [];
    let from = lineStart;

    while (from > 0) {
        const previousEnd = from - 1;
        const previousStart = lineStartOf(text, previousEnd);
        const contentEnd = trimEnd(text, previousStart, previousEnd);
        const comment = comments.find((span) => span.end === contentEnd && span.offset < contentEnd);

        if (comment === undefined) {
            break;
        }

        // A block comment may start lines above; its first line must hold nothing before it.
        const commentLine = lineStartOf(text, comment.offset);

        if (text.slice(commentLine, comment.offset) !== indent) {
            break;
        }

        found.unshift(comment);
        from = commentLine;
    }

    return { from, comments: found };
}

/** The tail of the line a node starts on: from the end of its content to the end of the line. */
function lineTail(text: string, comments: Span[], start: number): CommentSite["after"] {
    const lineEnd = lineEndOf(text, start);
    const contentEnd = trimEnd(text, start, lineEnd);
    const comment = comments.find((span) => span.offset > start && span.offset < contentEnd && span.end === contentEnd);
    let from = comment === undefined ? contentEnd : comment.offset;

    while (from > start && (text[from - 1] === " " || text[from - 1] === "\t")) {
        from--;
    }

    return { from, to: lineEnd, comment };
}

// Writing comments.

/** A comment's words: `# x` is `x`, `/* x *\/` is `x`, and a block's ` * ` decorations go. */
function words(source: string, block: boolean): string {
    if (!block) {
        return source.replace(/^(?:#|\/\/) ?/, "");
    }

    const inner = source.slice(2, -2);
    const lines = inner.split(/\r?\n/);

    if (lines.length === 1) {
        return inner.trim();
    }

    const body = lines.map((line) => line.replace(/^[ \t]*\* ?/, "").trimEnd());

    while (body.length > 0 && body[0]!.trim() === "") body.shift();
    while (body.length > 0 && body[body.length - 1]!.trim() === "") body.pop();

    return body.join("\n");
}

/** A one-line comment with its marker. */
function renderMarker(line: string, yaml: boolean, block: boolean): string {
    if (yaml) {
        return line === "" ? "#" : `# ${line}`;
    }

    if (block) {
        checkBlock(line);

        return `/* ${line} */`;
    }

    return line === "" ? "//" : `// ${line}`;
}

/** Comment lines above a node, each ending in the file's line ending. A JSONC block stays a block. */
function renderBefore(lines: string[], site: CommentSite, block: boolean): string {
    const { indent, eol } = site;

    if (block && !site.yaml) {
        lines.forEach(checkBlock);

        if (lines.length === 1) {
            return `${indent}/* ${lines[0]} */${eol}`;
        }

        return [`${indent}/*`, ...lines.map((line) => (line === "" ? `${indent} *` : `${indent} * ${line}`)), `${indent} */`].join(eol) + eol;
    }

    return lines.map((line) => `${indent}${renderMarker(line, site.yaml, false)}${eol}`).join("");
}

function checkBlock(line: string): void {
    if (line.includes("*/")) {
        throw new CommentError("A /* */ comment cannot hold '*/'.");
    }
}

/** The words a comment reads back as, once written: trailing spaces on each line are not kept by YAML's lexer. */
function normalize(comment: string): string {
    return comment.split(/\r?\n/).map((line) => line.trimEnd()).join("\n");
}

/**
 * Checks an edited text: it parses to the same value, and the comment reads back as written
 * (`expected`: the words, `undefined` for none, `null` to skip that check).
 */
function verify(before: string, after: string, format: CommentFormat, path: PathInput, place: CommentPlace, expected: string | undefined | null): void {
    const value = (text: string): JsonValue | undefined => {
        if (format === "yaml") {
            const doc = parseYamlModel(text);

            return doc.errors.length > 0 ? undefined : (doc.toJS() as JsonValue);
        }

        return parse(text, [], { allowTrailingComma: true }) as JsonValue;
    };
    const kept = deepEqual(value(after), value(before));
    let readsBack = true;

    if (kept && expected !== null) {
        const found = readComment(after, format, path, place);

        readsBack = (found === undefined ? undefined : normalize(found)) === expected;
    }

    if (!kept || !readsBack) {
        throw new CommentError(`A comment ${place} ${where(path)} cannot be written there without changing the file's values.`);
    }
}

// Lines.

function replace(text: string, from: number, to: number, content: string): string {
    return text.slice(0, from) + content + text.slice(to);
}

function lineStartOf(text: string, offset: number): number {
    // lastIndexOf with a negative start still finds a line break at 0.
    return offset <= 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
}

/** The end of the line holding an offset, before its line ending. */
function lineEndOf(text: string, offset: number): number {
    const end = text.indexOf("\n", offset);

    if (end === -1) {
        return text.length;
    }

    return text[end - 1] === "\r" ? end - 1 : end;
}
