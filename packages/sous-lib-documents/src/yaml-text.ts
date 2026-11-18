/**
 * Surgical edits to YAML text. The `yaml` package parses the text and says where each node is;
 * the edits themselves are made to the text, so every line an edit does not touch stays byte for
 * byte as it was: comments, key order, indentation, quoting style, blank lines, block and flow
 * style.
 *
 * When an edit cannot be made that way (see {@link editYamlText}), the caller falls back to
 * {@link reprintYaml}, which reprints the whole document through the `yaml` package's model: the
 * comments survive there, but spacing and layout may change.
 */
import {
    Document,
    isAlias,
    isMap,
    isScalar,
    isSeq,
    Pair,
    parseDocument,
    type Scalar,
    visit,
    type Node,
    type ParsedNode,
    type ToStringOptions,
    YAMLMap,
    YAMLSeq,
} from "yaml";
import { getAtPath } from "./json.js";
import { formatPath, parsePath } from "./path.js";
import type { JsonValue, Patch, PathSegment } from "./types.js";

/**
 * Parses YAML text into its document model. Empty text is an empty map.
 *
 * @throws Error naming the first syntax problem.
 */
export function parseYamlText(text: string): Document {
    const doc = parseDocument(text, { keepSourceTokens: false });

    if (doc.errors.length > 0) {
        throw new Error(`The YAML text is not valid: ${doc.errors[0]!.message}`);
    }

    if (doc.contents === null) {
        doc.contents = doc.createNode({}) as never;
    }

    return doc;
}

/** The plain value of a YAML document. */
export function yamlValue(doc: Document): JsonValue {
    return (doc.toJS() ?? {}) as JsonValue;
}

/** How a YAML text writes what it holds, so new lines match the old ones. */
export interface YamlStyle {
    /** Spaces per level of indentation. */
    indent: number;
    /** How many columns right of its key a list's dashes sit: `2` for `key:\n  - a`, `0` for `key:\n- a`. */
    seqIndent: number;
    /** How most strings are quoted. */
    stringType: "PLAIN" | "QUOTE_DOUBLE" | "QUOTE_SINGLE";
    /** The line ending. */
    eol: string;
}

/**
 * Reads how a YAML text is written: its indentation, how far lists sit under their key, how
 * strings are quoted, and its line ending. Each is read from the first example in the text; with
 * none, the defaults are 2, 2, plain and `\n`.
 *
 * ```ts
 * detectYamlStyle("a:\n    b: 'x'\n");   // { indent: 4, seqIndent: 2, stringType: "QUOTE_SINGLE", eol: "\n" }
 * ```
 */
export function detectYamlStyle(text: string): YamlStyle {
    const style: YamlStyle = { indent: 2, seqIndent: 2, stringType: "PLAIN", eol: text.includes("\r\n") ? "\r\n" : "\n" };
    const doc = parseDocument(text);

    if (doc.errors.length > 0) {
        return style;
    }

    let indentFound = false;
    let seqFound = false;
    const counts = { PLAIN: 0, QUOTE_DOUBLE: 0, QUOTE_SINGLE: 0 };

    visit(doc, {
        Pair(_, pair) {
            const key = pair.key as ParsedNode | null;
            const value = pair.value as ParsedNode | null;

            if (key?.range === undefined || value?.range === undefined) {
                return;
            }

            const keyColumn = columnOf(text, key.range[0]);

            if (!indentFound && isMap(value) && !value.flow && onLaterLine(text, key.range[0], value.range[0])) {
                const width = columnOf(text, value.range[0]) - keyColumn;

                if (width > 0) {
                    style.indent = width;
                    indentFound = true;
                }
            }

            if (!seqFound && isSeq(value) && !value.flow && onLaterLine(text, key.range[0], value.range[0])) {
                style.seqIndent = Math.max(0, columnOf(text, value.range[0]) - keyColumn);
                seqFound = true;
            }

            // Only a string that could be written bare counts: the style of one that could not was not a choice.
            if (isScalar(value) && typeof value.value === "string" && value.type !== undefined && value.type in counts && naturalStringType(value.value) === "PLAIN") {
                counts[value.type as keyof typeof counts]++;
            }
        },
        Seq(_, seq) {
            for (const item of seq.items) {
                if (isScalar(item) && typeof item.value === "string" && item.type !== undefined && item.type in counts && naturalStringType(item.value) === "PLAIN") {
                    counts[item.type as keyof typeof counts]++;
                }
            }
        },
    });

    if (counts.QUOTE_DOUBLE > counts.PLAIN + counts.QUOTE_SINGLE) {
        style.stringType = "QUOTE_DOUBLE";
    } else if (counts.QUOTE_SINGLE > counts.PLAIN + counts.QUOTE_DOUBLE) {
        style.stringType = "QUOTE_SINGLE";
    }

    return style;
}

/** One change to a text: replace `length` characters at `offset` with `content`. */
export interface TextEdit {
    offset: number;
    length: number;
    content: string;
}

/** Applies text edits that do not overlap, in any order. */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
    let result = text;

    for (const edit of [...edits].sort((a, b) => b.offset - a.offset)) {
        result = result.slice(0, edit.offset) + edit.content + result.slice(edit.offset + edit.length);
    }

    return result;
}

/**
 * Text a removed key or list item had, kept so that putting the same value back (as moving a key
 * or sorting a list does) writes the old text, with its comments and quoting, instead of new text.
 */
export interface RemovedText {
    /** Where it was removed from: the container's path and the key, or the container's path and `[]`. */
    where: string;
    /** Its value. */
    value: JsonValue;
    /** The lines it had, from the start of its first line to the end of its last. */
    text: string;
    /** The column its key or dash was at. */
    column: number;
}

/**
 * Applies one primitive to YAML text, changing only the lines it must. `after` is the
 * document's whole value once the patch is applied; the patch is known to apply.
 *
 * Returns `undefined` when the edit cannot be made surgically: a document whose text and model
 * disagree, a key written with `?`, a list item whose value starts on the line after its dash,
 * or anything else this editor does not recognize. The caller then reprints the document.
 */
export function editYamlText(text: string, patch: Patch, after: JsonValue, style: YamlStyle, removed: RemovedText[] = []): string | undefined {
    const doc = parseDocument(text);

    /* c8 ignore next 3: the caller only edits text that parsed */
    if (doc.errors.length > 0) {
        return undefined;
    }

    const editor = new YamlTextEditor(text, doc, after, style, removed);
    const edits = editor.edits(patch);

    return edits === undefined ? undefined : applyTextEdits(text, edits);
}

/**
 * Applies one primitive (known to apply) to a YAML document model and reprints the whole
 * document: the fallback when {@link editYamlText} cannot edit the text surgically.
 */
export function reprintYaml(text: string, patch: Patch): string {
    const doc = parseYamlText(text);

    editYaml(doc, patch);

    return doc.toString({ flowCollectionPadding: false });
}

/** Applies one primitive (known to apply) to a YAML document model in place. */
export function editYaml(doc: Document, patch: Patch): void {
    const path = parsePath(patch.path);

    switch (patch.op) {
        case "setKey":
            setValue(doc, [...path, patch.key], patch.value);
            break;
        case "setIndex":
            setValue(doc, [...path, patch.index], patch.value);
            break;
        case "deleteKey":
            doc.deleteIn([...path, patch.key]);
            break;
        case "removeIndex":
            (doc.getIn(path, true) as YAMLSeq).items.splice(patch.index, 1);
            break;
        case "renameKey":
            rename(doc.getIn(path, true) as YAMLMap, patch.key, patch.to, doc);
            break;
        case "insertAt": {
            const seq = path.length === 0 ? doc.contents : doc.getIn(path, true);

            if (!isSeq(seq)) {
                setValue(doc, path, [patch.value]);
                break;
            }

            const index = patch.index === "end" ? seq.items.length : patch.index;

            seq.items.splice(index, 0, doc.createNode(patch.value));
            break;
        }
    }
}

/** Sets a value in a model; a scalar replacing a scalar keeps the old node, and with it its comments. */
function setValue(doc: Document, path: PathSegment[], value: JsonValue): void {
    if (path.length === 0) {
        doc.contents = doc.createNode(value) as never;

        return;
    }

    const existing = doc.getIn(path, true);
    const isPlainScalar = value === null || typeof value !== "object";

    if (isPlainScalar && isScalar(existing)) {
        existing.value = value;

        return;
    }

    doc.setIn(path, doc.createNode(value));
}

function rename(map: YAMLMap, from: string, to: string, doc: Document): void {
    const clash = map.items.findIndex((pair) => keyText(pair) === to);

    if (clash !== -1) {
        map.items.splice(clash, 1);
    }

    const pair = map.items.find((item) => keyText(item) === from)!;

    if (isScalar(pair.key)) {
        pair.key.value = to;
    } else {
        /* c8 ignore next: a complex YAML key, which a JSON path cannot name */
        pair.key = doc.createNode(to);
    }
}

/** A pair's key as the string a JSON path names it by, or `undefined` for a complex key. */
function keyText(pair: Pair): string | undefined {
    if (isScalar(pair.key)) {
        return String(pair.key.value);
    }

    /* c8 ignore next: a complex YAML key, which a JSON path cannot name */
    return typeof pair.key === "string" ? pair.key : undefined;
}

type Collection = YAMLMap<unknown, unknown> & ParsedNode | YAMLSeq<unknown> & ParsedNode;

/** Computes the text edits for one primitive. Every method returns `undefined` when it cannot. */
class YamlTextEditor {
    constructor(
        private readonly text: string,
        private readonly doc: Document,
        private readonly after: JsonValue,
        private readonly style: YamlStyle,
        private readonly removed: RemovedText[],
    ) {}

    edits(patch: Patch): TextEdit[] | undefined {
        const path = parsePath(patch.path);

        // A change below an alias (`*name`) writes the alias's value out in its place, changed.
        for (let depth = 1; depth <= path.length; depth++) {
            if (isAlias(this.node(path.slice(0, depth)))) {
                return this.replaceValue(path.slice(0, depth));
            }
        }

        switch (patch.op) {
            case "setKey":
                return this.setValue([...path, patch.key]);
            case "setIndex":
                return this.replaceValue([...path, patch.index]);
            case "deleteKey":
                return this.removePair(path, patch.key);
            case "removeIndex":
                return this.removeItem(path, patch.index);
            case "renameKey":
                return this.rename(path, patch.key, patch.to);
            case "insertAt": {
                const node = this.node(path);

                if (isSeq(node)) {
                    return this.insertItem(path, node as Collection & YAMLSeq, patch.index === "end" ? node.items.length : patch.index);
                }

                return this.setValue(path);
            }
        }
    }

    // Finding nodes.

    /** The node at a path, `null` for the empty document, or `undefined` when missing. */
    private node(path: readonly PathSegment[]): ParsedNode | null | undefined {
        if (path.length === 0) {
            return this.doc.contents as ParsedNode | null;
        }

        const parent = this.node(path.slice(0, -1));
        const last = path[path.length - 1]!;

        if (isMap(parent)) {
            const pair = this.pair(parent as Collection & YAMLMap, last);

            return pair === undefined ? undefined : (pair.value as ParsedNode | null);
        }

        if (isSeq(parent) && typeof last === "number") {
            return parent.items[last] as ParsedNode | undefined;
        }

        return undefined;
    }

    private pair(map: YAMLMap, key: PathSegment): Pair<ParsedNode, ParsedNode | null> | undefined {
        return map.items.find((pair) => keyText(pair as Pair) === String(key)) as Pair<ParsedNode, ParsedNode | null> | undefined;
    }

    private valueAt(path: readonly PathSegment[]): JsonValue {
        return getAtPath(this.after, path) as JsonValue;
    }

    // The primitives.

    /**
     * Sets the value at a path to its value in `after`: replaces the node when it exists, or adds
     * a key to the deepest map that exists, holding the missing maps nested around the value.
     */
    private setValue(path: PathSegment[]): TextEdit[] | undefined {
        let depth = 0;

        while (depth < path.length && this.node(path.slice(0, depth + 1)) !== undefined) {
            depth++;
        }

        if (depth === path.length) {
            return this.replaceValue(path);
        }

        const parentPath = path.slice(0, depth);
        const parent = this.node(parentPath);

        if (isMap(parent) && typeof path[depth] === "string") {
            return this.addPair(parentPath, parent as Collection & YAMLMap, path[depth] as string);
        }

        return this.replaceValue(parentPath);
    }

    /** Replaces the node at a path, which exists, with its value in `after`. */
    private replaceValue(path: PathSegment[]): TextEdit[] | undefined {
        const value = this.valueAt(path);

        if (path.length === 0) {
            return this.replaceRoot(value);
        }

        const parentPath = path.slice(0, -1);
        const parent = this.node(parentPath) as Collection;
        const last = path[path.length - 1]!;
        const old = (isMap(parent) ? this.pair(parent, last)!.value : parent.items[last as number]) as ParsedNode | null;

        if (parent.flow) {
            /* c8 ignore next 3: a flow pair always has a value node */
            if (old?.range === undefined) {
                return undefined;
            }

            return [{ offset: old.range[0], length: old.range[1] - old.range[0], content: this.flowText(this.makeNode(value, old)) }];
        }

        if (isMap(parent)) {
            const pair = this.pair(parent, last)!;
            const colon = this.colonAfter(pair.key);

            if (colon === undefined) {
                return undefined;
            }

            return this.replaceAfterIndicator(colon + 1, old, this.afterColon(this.makeNode(value, old), columnOf(this.text, pair.key.range[0])));
        }

        /* c8 ignore next 3: a block list item always has a node */
        if (old === null) {
            return undefined;
        }

        const dash = this.dashOf(old);

        if (dash === undefined) {
            return undefined;
        }

        return this.replaceAfterIndicator(dash + 1, old, this.afterDash(this.makeNode(value, old), columnOf(this.text, dash)));
    }

    /**
     * Replaces what follows a `:` or `-` with `rendered` (which starts with a space, or with a line
     * break for a block collection). A comment after an inline value keeps its line.
     */
    private replaceAfterIndicator(start: number, old: ParsedNode | null, rendered: string): TextEdit[] {
        if (old === null || old.range === undefined) {
            return [{ offset: start, length: 0, content: this.eol(rendered) }];
        }

        const end = old.range[1];
        const replaced = this.text.slice(start, end);
        const endsLine = replaced.endsWith("\n");

        if (!endsLine && rendered.startsWith("\n")) {
            const lineEnd = this.text.indexOf("\n", end);
            const rest = this.text.slice(end, lineEnd === -1 ? this.text.length : lineEnd);

            if (rest.trim().startsWith("#")) {
                // `key: 1 # note` becoming a block: `key: # note` and the block below it.
                const breakAt = lineEnd === -1 ? this.text.length : this.text[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;

                return [
                    { offset: start, length: end - start, content: "" },
                    { offset: breakAt, length: 0, content: this.eol(rendered) },
                ];
            }
        }

        return [{ offset: start, length: end - start, content: this.eol(rendered) + (endsLine ? this.style.eol : "") }];
    }

    /** Replaces the whole document's value. */
    private replaceRoot(value: JsonValue): TextEdit[] {
        const root = this.doc.contents as ParsedNode | null;
        const rendered = this.eol(this.render(this.makeNode(value, root)).replace(/\n$/, ""));

        if (root === null) {
            return [this.appendAtEnd(rendered)];
        }

        const replaced = this.text.slice(root.range[0], root.range[1]);

        return [{ offset: root.range[0], length: root.range[1] - root.range[0], content: rendered + (replaced.endsWith("\n") ? this.style.eol : "") }];
    }

    /** Adds a key, missing from a map, holding its value in `after`. */
    private addPair(mapPath: PathSegment[], map: Collection & YAMLMap, key: string): TextEdit[] | undefined {
        const value = this.valueAt([...mapPath, key]);
        const pairs = map.items as Pair<ParsedNode, ParsedNode | null>[];

        if (pairs.length === 0) {
            // An empty `{}`: written again whole, as a block when it is not inside a flow collection.
            return this.replaceValue(mapPath);
        }

        if (map.flow) {
            return this.insertFlow(map, pairs.length, this.flowPairText(key, this.makeNode(value)));
        }

        const last = pairs[pairs.length - 1]!;
        const column = columnOf(this.text, pairs[0]!.key.range[0]);
        const reused = this.takeRemoved(`${formatPath(mapPath)}\u0000${key}`, value, column);
        const content = reused ?? `${" ".repeat(column)}${this.eol(this.pairText(key, this.makeNode(value), column))}${this.style.eol}`;

        return [this.insertAtLineEnd(lineEndAfter(this.text, (last.value ?? last.key).range[1]), content)];
    }

    /** Removes a key from a map. */
    private removePair(mapPath: PathSegment[], key: string): TextEdit[] | undefined {
        const map = this.node(mapPath) as Collection & YAMLMap;
        const pairs = map.items as Pair<ParsedNode, ParsedNode | null>[];
        const index = pairs.findIndex((pair) => keyText(pair as Pair) === key);
        const pair = pairs[index]!;
        const start = pair.key.range[0];
        const end = (pair.value ?? pair.key).range[1];

        if (map.flow) {
            return this.removeFlow(pairs.map((item) => [item.key.range[0], (item.value ?? item.key).range[1]]), index);
        }

        if (pairs.length === 1 && mapPath.length > 0) {
            // The map becomes empty, written `{}` (an empty block would read as null).
            return this.replaceValue(mapPath);
        }

        if (isLineStart(this.text, start)) {
            const from = lineStartOf(this.text, start);
            const to = lineEndAfter(this.text, end);

            this.remember(`${formatPath(mapPath)}\u0000${key}`, [...mapPath, key], from, to, columnOf(this.text, start));

            return [{ offset: from, length: to - from, content: "" }];
        }

        if (pairs.length === 1) {
            // The only key of the root, written after `--- `: the document becomes empty.
            return [{ offset: start, length: lineEndAfter(this.text, end) - start, content: "" }];
        }

        // The first key of a map that starts after `- `: the next key moves up onto the dash's line.
        return [{ offset: start, length: pairs[index + 1]!.key.range[0] - start, content: "" }];
    }

    /** Renames a key in place; a key already holding the new name is removed. */
    private rename(mapPath: PathSegment[], from: string, to: string): TextEdit[] | undefined {
        const map = this.node(mapPath) as Collection & YAMLMap;
        const pair = this.pair(map, from)!;
        const keyNode = pair.key as ParsedNode;
        const renamed = this.makeKey(to, keyNode);
        const edits: TextEdit[] = [{
            offset: keyNode.range[0],
            length: keyNode.range[1] - keyNode.range[0],
            content: map.flow ? this.flowText(renamed) : this.keyText(renamed),
        }];

        if (this.pair(map, to) !== undefined) {
            const removal = this.removePair(mapPath, to);

            if (removal === undefined) {
                return undefined;
            }

            edits.push(...removal);
        }

        return edits;
    }

    /** Inserts an item into a list at an index. */
    private insertItem(path: PathSegment[], seq: Collection & YAMLSeq, index: number): TextEdit[] | undefined {
        const value = this.valueAt([...path, index]);
        const items = seq.items as (ParsedNode | null)[];

        if (items.length === 0) {
            return this.replaceValue(path);
        }

        if (seq.flow) {
            return this.insertFlow(seq, index, this.flowText(this.makeNode(value)));
        }

        const dashes = items.map((item) => (item === null ? undefined : this.dashOf(item)));

        if (dashes.some((dash) => dash === undefined)) {
            return undefined;
        }

        const column = columnOf(this.text, dashes[0]!);
        const reused = this.takeRemoved(`${formatPath(path)}\u0000[]`, value, column);

        if (index < items.length) {
            const dash = dashes[index]!;

            if (reused !== undefined && isLineStart(this.text, dash)) {
                return [{ offset: lineStartOf(this.text, dash), length: 0, content: reused }];
            }

            const item = `-${this.eol(this.afterDash(this.makeNode(value), column))}`;

            return [{ offset: dash, length: 0, content: `${item}${this.style.eol}${" ".repeat(column)}` }];
        }

        const lastItem = items[items.length - 1]!;
        const content = reused ?? `${" ".repeat(column)}-${this.eol(this.afterDash(this.makeNode(value), column))}${this.style.eol}`;

        return [this.insertAtLineEnd(lineEndAfter(this.text, lastItem.range[1]), content)];
    }

    /** Removes the item at an index of a list. */
    private removeItem(path: PathSegment[], index: number): TextEdit[] | undefined {
        const seq = this.node(path) as Collection & YAMLSeq;
        const items = seq.items as ParsedNode[];

        if (seq.flow) {
            return this.removeFlow(items.map((item) => [item.range[0], item.range[1]]), index);
        }

        if (items.length === 1) {
            // The list becomes empty, written `[]` (an empty block would read as null).
            return this.replaceValue(path);
        }

        const item = items[index]!;
        const dash = this.dashOf(item);

        if (dash === undefined) {
            return undefined;
        }

        if (isLineStart(this.text, dash)) {
            const from = lineStartOf(this.text, dash);
            const to = lineEndAfter(this.text, item.range[1]);

            this.remember(`${formatPath(path)}\u0000[]`, [...path, index], from, to, columnOf(this.text, dash));

            return [{ offset: from, length: to - from, content: "" }];
        }

        const next = items[index + 1] === undefined ? undefined : this.dashOf(items[index + 1]!);

        /* c8 ignore next 3: only the first item can share a line, and a list of two has a next */
        if (next === undefined) {
            return undefined;
        }

        return [{ offset: dash, length: next - dash, content: "" }];
    }

    // Flow collections: `[a, b]` and `{a: 1}`.

    private insertFlow(collection: Collection, index: number, entry: string): TextEdit[] {
        const items = collection.items as unknown[];
        const starts = items.map((item) => (isMap(collection) ? ((item as Pair).key as ParsedNode) : (item as ParsedNode)).range[0]);

        if (index < items.length) {
            return [{ offset: starts[index]!, length: 0, content: `${entry}, ` }];
        }

        const lastItem = items[items.length - 1];
        const lastEnd = isMap(collection)
            ? (((lastItem as Pair).value ?? (lastItem as Pair).key) as ParsedNode).range[1]
            : (lastItem as ParsedNode).range[1];
        const afterLast = skipSpaces(this.text, lastEnd);

        return this.text[afterLast] === ","
            ? [{ offset: afterLast + 1, length: 0, content: ` ${entry},` }]
            : [{ offset: lastEnd, length: 0, content: `, ${entry}` }];
    }

    private removeFlow(spans: [number, number][], index: number): TextEdit[] {
        const [start, end] = spans[index]!;
        const next = spans[index + 1];

        if (next !== undefined) {
            return [{ offset: start, length: next[0] - start, content: "" }];
        }

        const previous = spans[index - 1];

        if (previous === undefined) {
            return [{ offset: start, length: end - start, content: "" }];
        }

        return [{ offset: previous[1], length: end - previous[1], content: "" }];
    }

    // Where things are in the text.

    /** The offset of the `:` after a key, or `undefined` when something else is there. */
    private colonAfter(key: ParsedNode): number | undefined {
        const at = skipSpaces(this.text, key.range[1]);

        return this.text[at] === ":" ? at : undefined;
    }

    /** The offset of a block list item's dash, on the item's own line, or `undefined`. */
    private dashOf(item: ParsedNode): number | undefined {
        let at = item.range[0] - 1;

        while (at >= 0 && (this.text[at] === " " || this.text[at] === "\t")) {
            at--;
        }

        return this.text[at] === "-" ? at : undefined;
    }

    /** An insertion at a line end; at the end of a text with no final line break, adds one first. */
    private insertAtLineEnd(offset: number, content: string): TextEdit {
        if (offset === this.text.length && this.text.length > 0 && !this.text.endsWith("\n")) {
            return { offset, length: 0, content: this.style.eol + content };
        }

        return { offset, length: 0, content };
    }

    private appendAtEnd(rendered: string): TextEdit {
        return this.insertAtLineEnd(this.text.length, rendered + this.style.eol);
    }

    // Reusing the text of what was removed.

    /** Keeps the text of what is about to be removed, with its value read from the text's own model. */
    private remember(where: string, path: PathSegment[], from: number, to: number, column: number): void {
        const value = getAtPath(this.doc.toJS() as JsonValue, path);

        if (value !== undefined) {
            this.removed.push({ where, value, text: this.text.slice(from, to), column });
        }
    }

    private takeRemoved(where: string, value: JsonValue, column: number): string | undefined {
        const index = this.removed.findIndex((entry) => entry.where === where && entry.column === column
            && JSON.stringify(entry.value) === JSON.stringify(value));

        if (index === -1) {
            return undefined;
        }

        const [entry] = this.removed.splice(index, 1);
        const text = entry!.text;

        return text.endsWith("\n") ? text : text + this.style.eol;
    }

    // Writing new values.

    /**
     * A node for a value, written like the node it replaces when there is one. A string takes the
     * old string's quoting or block style only when the author chose it: a style the old value
     * needed (`">> x"` must be quoted, a text of several lines is a block) says nothing about the
     * new one, which is written in the file's usual style. A text of several lines is a block
     * (`|-`) unless the author chose otherwise.
     *
     * ```yaml
     * notes: ">> hello"   # set to "hello" -> notes: hello
     * notes: "hello"      # set to "bye"   -> notes: "bye"
     * ```
     */
    private makeNode(value: JsonValue, like?: ParsedNode | null): Node {
        const node = new Document().createNode(value) as Node;

        if (isScalar(node) && typeof value === "string") {
            const chosen =
                isScalar(like) && typeof like.value === "string" && like.type !== undefined && naturalStringType(like.value) === "PLAIN"
                    ? like.type
                    : undefined;
            const lines = value.includes("\n");

            if (chosen !== undefined && !(lines && chosen === "PLAIN")) {
                node.type = chosen;
            } else if (!lines) {
                node.type = this.style.stringType;
            }
        }

        if ((isMap(node) || isSeq(node)) && (isMap(like) || isSeq(like)) && like.flow && like.items.length > 0) {
            node.flow = true;
        }

        return node;
    }

    /** A node for a key: written like the key it replaces, or plain when it can be. */
    private makeKey(key: string, like?: ParsedNode): Node {
        const node = new Document().createNode(key) as Scalar;

        node.type = isScalar(like) && like.type !== undefined ? like.type : "PLAIN";

        return node;
    }

    /**
     * How the `yaml` package writes new text. It can put a list's dashes `indent` columns right of
     * their key, or `indent - 2`, so a file whose lists sit at another depth (`0` with maps at 4)
     * gets new lists at the nearest of the two.
     */
    private options(): ToStringOptions {
        const { indent, seqIndent } = this.style;

        return {
            indent,
            indentSeq: seqIndent >= indent,
            lineWidth: 0,
            flowCollectionPadding: false,
            defaultStringType: this.style.stringType,
            defaultKeyType: "PLAIN",
        };
    }

    private render(node: Node): string {
        const doc = new Document();

        doc.contents = node as never;

        return doc.toString(this.options());
    }

    /** What follows `key:` for a value: ` 1`, or a line break and the block, indented under the key. */
    private afterColon(node: Node, keyColumn: number): string {
        const map = new YAMLMap();

        map.items.push(new Pair("x", node));

        return indentLines(this.render(map).replace(/\n$/, "").slice(2), keyColumn);
    }

    /** What follows `-` for an item: ` 1`, or ` a: 1` and the rest of the block below it. */
    private afterDash(node: Node, dashColumn: number): string {
        const seq = new YAMLSeq();

        seq.items.push(node);

        return indentLines(this.render(seq).replace(/\n$/, "").slice(1), dashColumn);
    }

    /** A whole `key: value` entry, its later lines indented to sit at `column`. */
    private pairText(key: string, node: Node, column: number): string {
        return `${this.keyText(this.makeKey(key))}:${this.afterColon(node, column)}`;
    }

    /** A key, quoted only when it must be. */
    private keyText(node: Node): string {
        return this.render(node).replace(/\n$/, "");
    }

    /** A value as it is written inside `[...]` or `{...}`. */
    private flowText(node: Node): string {
        const seq = new YAMLSeq();

        seq.flow = true;
        seq.items.push(node);

        return this.render(seq).replace(/\n$/, "").slice(1, -1);
    }

    private flowPairText(key: string, node: Node): string {
        const map = new YAMLMap();

        map.flow = true;
        map.items.push(new Pair(this.makeKey(key), node));

        return this.render(map).replace(/\n$/, "").slice(1, -1);
    }

    /** Text with the file's own line ending. */
    private eol(text: string): string {
        return this.style.eol === "\n" ? text : text.replace(/\n/g, this.style.eol);
    }
}

/** Indents every line but the first by `column` spaces. */
function indentLines(text: string, column: number): string {
    if (column === 0) {
        return text;
    }

    const pad = " ".repeat(column);

    return text.replace(/\n/g, `\n${pad}`);
}

/**
 * The style the `yaml` package gives a string left to itself: `PLAIN` when it can be written
 * bare, otherwise the quoting or block style it needs.
 *
 * naturalStringType("hello");     // "PLAIN"
 * naturalStringType(">> hello");  // "QUOTE_DOUBLE"
 * naturalStringType("a\nb");      // "BLOCK_LITERAL"
 */
function naturalStringType(value: string): Scalar.Type {
    const first = new Document(value).toString()[0];

    return first === '"' ? "QUOTE_DOUBLE" : first === "'" ? "QUOTE_SINGLE" : first === "|" ? "BLOCK_LITERAL" : first === ">" ? "BLOCK_FOLDED" : "PLAIN";
}

function lineStartOf(text: string, offset: number): number {
    return text.lastIndexOf("\n", offset - 1) + 1;
}

/** The column of an offset on its line. */
function columnOf(text: string, offset: number): number {
    return offset - lineStartOf(text, offset);
}

/** Whether only whitespace comes before an offset on its line. */
function isLineStart(text: string, offset: number): boolean {
    return text.slice(lineStartOf(text, offset), offset).trim() === "";
}

function onLaterLine(text: string, from: number, to: number): boolean {
    return text.slice(from, to).includes("\n");
}

/** The start of the next line after an offset, or the offset itself when a line starts there. */
function lineEndAfter(text: string, offset: number): number {
    if (offset === 0 || text[offset - 1] === "\n") {
        return offset;
    }

    const end = text.indexOf("\n", offset);

    return end === -1 ? text.length : end + 1;
}

function skipSpaces(text: string, offset: number): number {
    let at = offset;

    while (text[at] === " " || text[at] === "\t") {
        at++;
    }

    return at;
}
