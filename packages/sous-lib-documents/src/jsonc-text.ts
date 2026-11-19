/**
 * Surgical edits to JSON and JSONC text. Offsets come from jsonc-parser's syntax tree; the edits
 * themselves are computed here, line by line, so comments, key order and the file's own layout
 * survive and nothing around an edit is reformatted.
 *
 * A key or list item on lines of its own is an "entry block": the comment lines directly above it
 * (its "before" comment, as `comments.ts` defines it), its own lines, and the comment ending its
 * last line. Removing, moving and reordering an entry carries its whole block; blank lines (and
 * comments that belong to no entry) are not part of any block, so they stay where they are.
 *
 * ```jsonc
 * {
 *     "a": 1,
 *                          <- a blank line: stays between the places, never moves
 *     // about b           <- b's block starts here
 *     "b": 2, // two       <- and ends at the end of this line
 * }
 * ```
 */
import { applyEdits, findNodeAtLocation, parse, parseTree, type Edit, type Node, type ParseError } from "jsonc-parser";
import { commentLinesAbove } from "./comments.js";
import { child, deepEqual, getAtPath, isJsonObject } from "./json.js";
import { formatPath, parsePath } from "./path.js";
import type { EntrySource, JsonValue, Patch, PathSegment, Placement } from "./types.js";

/** How the text is laid out: one level of indentation, and the line ending. */
export interface TextLayout {
    unit: string;
    eol: string;
}

/**
 * Reads the indentation unit (tabs or a number of spaces) and the line ending a text uses.
 *
 * ```ts
 * detectLayout('{\n\t"a": 1\n}');   // { unit: "\t", eol: "\n" }
 * ```
 */
export function detectLayout(text: string): TextLayout {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const match = /^([ \t]+)\S/m.exec(text);

    if (match === null) {
        return { unit: "    ", eol };
    }

    const indent = match[1]!;

    return { unit: indent.startsWith("\t") ? "\t" : indent, eol };
}

/**
 * Parses JSON or JSONC text (comments and trailing commas allowed). Empty text is `{}`.
 *
 * @throws Error naming the first syntax problem and where it is.
 */
export function parseJsoncText(text: string): JsonValue {
    if (text.trim() === "") {
        return {};
    }

    const errors: ParseError[] = [];
    const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as JsonValue;

    if (errors.length > 0) {
        const offset = errors[0]!.offset;
        const line = text.slice(0, offset).split("\n").length;

        throw new Error(`The JSON text is not valid: a syntax error at line ${line} (character ${offset + 1}).`);
    }

    return value;
}

/**
 * The text of a property or an array item an edit removed, kept so that putting the same value
 * back in the same place (as moving a key or sorting a list does) writes the old text, with its
 * comments, instead of new text.
 */
export interface RemovedJsoncText {
    /** The container's path and the key, or the container's path and `[]` for an array item. */
    where: string;
    value: JsonValue;
    /** Its source, as {@link EntrySource} describes it: its whole block, or its text alone. */
    source: string;
}

/** What else an edit is told: where a new entry goes, and the text to write for it. */
export interface JsoncEditOptions {
    /** For a `setKey` adding a key or an `insertAt`: where the new entry goes. */
    placement?: Placement;
    /**
     * The text to write: for a new entry, an {@link EntrySource}'s text; for a `setKey` or
     * `setIndex` replacing a value, the value's text. Used only when it reads as the value.
     */
    source?: string;
}

/**
 * Applies one primitive to JSON or JSONC text. `before` is the document's value before the patch
 * and `after` its value after; the patch is known to apply. `removed` carries the text of what
 * earlier edits removed, from one edit to the next.
 */
export function editJsoncText(
    text: string,
    patch: Patch,
    before: JsonValue | undefined,
    after: JsonValue,
    layout: TextLayout,
    removed: RemovedJsoncText[] = [],
    options: JsoncEditOptions = {},
): string {
    const tree = text.trim() === "" ? undefined : parseTree(text, [], { allowTrailingComma: true });

    if (tree === undefined) {
        return stringify(after, "", layout) + layout.eol;
    }

    const editor = new JsoncEditor(text, tree, layout, removed);
    const path = parsePath(patch.path);

    return applyEdits(text, editor.edits(patch, path, before, options));
}

/**
 * A key or item exactly as written, and where it is (see {@link EntrySource}), or `undefined`
 * when there is nothing at the path or it is the root.
 *
 * ```ts
 * jsoncEntrySource('{\n    "a": 1,\n    // about b\n    "b": 2\n}\n', "b");
 * // { source: '    // about b\n    "b": 2\n', index: 1, after: "a" }
 * ```
 */
export function jsoncEntrySource(text: string, input: PathSegment[]): EntrySource | undefined {
    const tree = parseTree(text, [], { allowTrailingComma: true });
    const target = tree === undefined || input.length === 0 ? undefined : findNodeAtLocation(tree, input);

    if (target === undefined) {
        return undefined;
    }

    const editor = new JsoncEditor(text, tree!, detectLayout(text), []);

    return editor.entrySource(typeof input[input.length - 1] === "string" ? target.parent! : target);
}

/** A value exactly as written (`["only"]`), or `undefined` when there is none at the path. */
export function jsoncValueSource(text: string, path: PathSegment[]): string | undefined {
    const tree = parseTree(text, [], { allowTrailingComma: true });
    const node = tree === undefined ? undefined : path.length === 0 ? tree : findNodeAtLocation(tree, path);

    return node === undefined ? undefined : text.slice(node.offset, node.offset + node.length);
}

/**
 * Puts the keys of the object, or the items of the list, at a path in a new order: `order[i]` is
 * the old index of the entry that goes to place `i`. Entries on lines of their own swap whole
 * blocks (comment lines above and the comment ending the line included), and the blank lines
 * between the places stay where they are; commas are written again for the new last entry.
 * Entries that share lines swap only their own text. `undefined` when the container cannot be
 * reordered this way (entries on their own lines mixed with others).
 */
export function reorderJsoncText(text: string, path: PathSegment[], order: readonly number[]): string | undefined {
    const tree = parseTree(text, [], { allowTrailingComma: true });
    const container = tree === undefined ? undefined : path.length === 0 ? tree : findNodeAtLocation(tree, path);

    if (container === undefined || (container.type !== "object" && container.type !== "array")) {
        return undefined;
    }

    return new JsoncEditor(text, tree!, detectLayout(text), []).reorder(container, order);
}

/** An entry on lines of its own: where its block starts and ends, and its comma. */
interface Block {
    /** The start of its first comment line above, or of its own line. */
    start: number;
    /** The start of its own (first) line. */
    lineStart: number;
    /** Just past the line break that ends its last line. */
    end: number;
    /** Where its last line's content ends, before the line break. */
    lineEnd: number;
    hasComma: boolean;
    /** Where its comma is, when it has one. */
    comma: number;
}

/** An entry's text taken apart, so it can be written again in another place. */
interface EntryParts {
    /** Its comment lines above, line endings included (`""` for none). */
    before: string;
    /** The whitespace starting its own line. */
    indent: string;
    /** The property (`"key": value`) or the item. */
    body: string;
    /** What lay between the body and its comma (usually nothing). */
    between: string;
    /** What followed its comma (or its body) on its last line: spaces and a comment. */
    after: string;
    /** Whether it was on lines of its own. */
    lines: boolean;
    /** The key's text within `body`, for a property. */
    key?: { offset: number; length: number; value: string };
}

/** Computes the text edits for one primitive. */
class JsoncEditor {
    private above: ((lineStart: number) => number) | undefined;

    constructor(
        private readonly text: string,
        private readonly tree: Node,
        private readonly layout: TextLayout,
        private readonly removed: RemovedJsoncText[],
    ) {}

    edits(patch: Patch, path: PathSegment[], before: JsonValue | undefined, options: JsoncEditOptions = {}): Edit[] {
        switch (patch.op) {
            case "setKey":
                return this.setAt([...path, patch.key], patch.value, before, options);
            case "setIndex":
                return this.replaceValue(this.node([...path, patch.index]), patch.value, options.source);
            case "deleteKey":
            case "removeIndex": {
                const last = patch.op === "deleteKey" ? patch.key : patch.index;
                const target = this.node([...path, last]);
                const element = patch.op === "deleteKey" ? target.parent! : target;

                this.removed.push({
                    where: whereOf(path, patch.op === "deleteKey" ? patch.key : undefined),
                    value: getAtPath(before, [...path, last]) as JsonValue,
                    source: this.sourceOf(element),
                });

                return this.removeElement(element);
            }
            case "renameKey":
                return this.rename(path, patch.key, patch.to);
            case "insertAt": {
                const container = findNodeAtLocation(this.tree, path);

                if (container === undefined) {
                    return this.createMissing(path, [patch.value], before);
                }

                const length = container.children?.length ?? 0;
                const index = options.placement?.index ?? (patch.index === "end" ? length : patch.index);
                const parts = this.reusedParts(whereOf(path), patch.value, options.source, false);
                const entry = parts ?? this.freshParts(this.format(patch.value, this.childIndent(container), this.oneLineAmong(container, index)));

                return this.insertElement(container, index, entry, options.placement);
            }
        }
    }

    /** A key or item's {@link EntrySource}. */
    entrySource(element: Node): EntrySource {
        const container = element.parent!;
        const siblings = container.children!;
        const index = siblings.indexOf(element);
        const block = this.block(element);
        const source: EntrySource = { source: this.sourceOf(element), index };
        const previous = siblings[index - 1];

        if (container.type === "object" && previous !== undefined) {
            source.after = previous.children![0]!.value as string;
        }

        if (block !== undefined) {
            const neighbour = previous === undefined ? siblings[index + 1] : previous;
            const other = neighbour === undefined ? undefined : this.block(neighbour);
            const between = other === undefined ? "" : previous === undefined ? this.text.slice(block.end, other.start) : this.text.slice(other.end, block.start);
            const gap = countLines(between);

            if (gap > 0) {
                source.gap = gap;
            }
        }

        return source;
    }

    /** See {@link reorderJsoncText}. */
    reorder(container: Node, order: readonly number[]): string | undefined {
        const children = container.children ?? [];

        if (order.length !== children.length) {
            return undefined;
        }

        const blocks = children.map((element) => this.block(element));

        if (blocks.every((block) => block !== undefined) && children.length > 0) {
            const all = blocks as Block[];
            const trailing = all[all.length - 1]!.hasComma;
            const parts = children.map((element, index) => this.partsOf(element, all[index]!));
            let result = this.text.slice(0, all[0]!.start);

            order.forEach((from, to) => {
                const last = to === order.length - 1;
                const entry = parts[from]!;
                const indent = lineIndent(this.text, children[to]!.offset);

                result += this.entryText(entry, indent, !last || trailing) + this.lineBreakAt(all[to]!.lineEnd);
                result += last ? "" : this.text.slice(all[to]!.end, all[to + 1]!.start);
            });

            return result + this.text.slice(all[all.length - 1]!.end);
        }

        if (blocks.some((block) => block !== undefined)) {
            // Some entries have lines of their own and some do not: moving only their text would
            // leave the comments on those lines behind.
            return undefined;
        }

        // Entries that share lines: each place keeps its spacing and only the entries' text moves.
        const texts = children.map((element) => this.text.slice(element.offset, element.offset + element.length));
        const edits: Edit[] = children.map((element, to) => ({ offset: element.offset, length: element.length, content: texts[order[to]!]! }));

        return applyEdits(this.text, edits);
    }

    private node(path: PathSegment[]): Node {
        return path.length === 0 ? this.tree : findNodeAtLocation(this.tree, path)!;
    }

    /** Sets a key: replaces an existing value, or adds the key (creating missing objects). */
    private setAt(path: PathSegment[], value: JsonValue, before: JsonValue | undefined, options: JsoncEditOptions): Edit[] {
        const existing = findNodeAtLocation(this.tree, path);

        if (existing !== undefined) {
            return this.replaceValue(existing, value, options.source);
        }

        return this.createMissing(path.slice(0, -1), value, before, path[path.length - 1] as string, options);
    }

    /**
     * Adds a value at a path whose end is missing: finds the deepest object that exists and adds
     * one key to it, holding the missing objects nested around the value.
     */
    private createMissing(path: PathSegment[], value: JsonValue, before: JsonValue | undefined, key?: string, options: JsoncEditOptions = {}): Edit[] {
        let depth = 0;

        while (depth < path.length && child(getAtPath(before, path.slice(0, depth)), path[depth]!) !== undefined) {
            depth++;
        }

        let nested: JsonValue = value;
        const missing = key === undefined ? path.slice(depth) : [...path.slice(depth), key];

        for (let i = missing.length - 1; i >= 1; i--) {
            nested = { [missing[i] as string]: nested };
        }

        const container = this.node(path.slice(0, depth));
        const direct = missing.length === 1;
        const parts = direct ? this.reusedParts(whereOf(path.slice(0, depth), missing[0] as string), nested, options.source, true, missing[0] as string) : undefined;
        const entry = parts ?? this.freshParts(`${JSON.stringify(missing[0])}: ${this.format(nested, this.childIndent(container), this.oneLineAmong(container))}`);
        const placement = direct ? options.placement : undefined;

        return this.insertElement(container, placement?.index ?? container.children?.length ?? 0, entry, placement);
    }

    /**
     * The parts of the text to write for a new entry: `source` when given and it reads as the
     * value, or else the old text of an equal value removed from the same place (taken, so it is
     * used once), or `undefined` for new text. A property's key is written as `key`.
     */
    private reusedParts(where: string, value: JsonValue, source: string | undefined, property: boolean, key?: string): EntryParts | undefined {
        if (source !== undefined) {
            const parts = readParts(source, property);

            if (parts !== undefined && deepEqual(partValue(parts, property), value)) {
                return key === undefined ? parts : withKey(parts, key);
            }
        }

        const index = this.removed.findIndex((entry) => entry.where === where && JSON.stringify(entry.value) === JSON.stringify(value));

        if (index === -1) {
            return undefined;
        }

        const parts = readParts(this.removed.splice(index, 1)[0]!.source, property);

        return parts === undefined || key === undefined ? parts : withKey(parts, key);
    }

    private freshParts(body: string): EntryParts {
        return { before: "", indent: "", body, between: "", after: "", lines: false };
    }

    /** An element's source: its whole block when it has lines of its own, or its text alone. */
    private sourceOf(element: Node): string {
        const block = this.block(element);

        return block === undefined ? this.text.slice(element.offset, element.offset + element.length) : this.text.slice(block.start, block.end);
    }

    /**
     * The block of an element that has lines of its own: only whitespace before it on its first
     * line, and only its comma, spaces and a comment after it on its last. `undefined` otherwise.
     */
    private block(element: Node): Block | undefined {
        if (!isLineStart(this.text, element.offset)) {
            return undefined;
        }

        const end = element.offset + element.length;
        const afterEnd = skipTrivia(this.text, end, true);
        const hasComma = this.text[afterEnd] === ",";
        const lineEnd = endOfLineAfter(this.text, hasComma ? afterEnd + 1 : end);

        if (lineEnd === -1) {
            return undefined;
        }

        const lineStart = lineStartOf(this.text, element.offset);

        this.above ??= commentLinesAbove(this.text, "jsonc");

        return { start: this.above(lineStart), lineStart, end: lineEnd + this.lineBreakLength(lineEnd), lineEnd, hasComma, comma: afterEnd };
    }

    /** An element's parts, read from the text around it. */
    private partsOf(element: Node, block: Block): EntryParts {
        const end = element.offset + element.length;

        return {
            before: this.text.slice(block.start, block.lineStart),
            indent: this.text.slice(block.lineStart, element.offset),
            body: this.text.slice(element.offset, end),
            between: block.hasComma ? this.text.slice(end, block.comma) : "",
            after: this.text.slice(block.hasComma ? block.comma + 1 : end, block.lineEnd),
            lines: true,
        };
    }

    /** An entry's text at an indentation, with or without its comma; no line break at the end. */
    private entryText(parts: EntryParts, indent: string, comma: boolean): string {
        const from = parts.lines ? parts.indent : indent;
        const shift = (text: string) => (from === indent ? text : reindent(text, from, indent));
        const before = shift(parts.before);
        const body = shift(parts.body);

        return `${before}${indent}${body}${parts.between}${comma ? "," : ""}${parts.after}`;
    }

    /**
     * Replaces a value: with `source` when it reads as the value (the text a value had, put back
     * as it was written), or else with new text, on one line when the value or its container was.
     */
    private replaceValue(node: Node, value: JsonValue, source?: string): Edit[] {
        if (source !== undefined && sourceReadsAs(source, value)) {
            return [{ offset: node.offset, length: node.length, content: source }];
        }

        const container = node.parent?.type === "property" ? node.parent.parent : node.parent;
        const oneLine = (isFilled(node) && this.onOneLine(node)) || (container !== undefined && isFilled(container) && this.onOneLine(container));

        return [{ offset: node.offset, length: node.length, content: this.format(value, lineIndent(this.text, node.offset), oneLine) }];
    }

    /**
     * Whether a value added to a container is written on one line: the container is on one line,
     * or (a list) the item next to where it goes is an object or list on one line.
     *
     * ```jsonc
     * "people": [
     *     { "id": 1 },      // a new item here is written { "id": 2 }, like this one
     * ]
     * ```
     */
    private oneLineAmong(container: Node, index?: number): boolean {
        if (!isFilled(container)) {
            return false;
        }

        if (this.onOneLine(container)) {
            return true;
        }

        if (container.type !== "array") {
            return false;
        }

        const children = container.children!;
        const at = index === undefined ? children.length : index;
        const neighbour = children[at - 1] ?? children[at];

        return neighbour !== undefined && isFilled(neighbour) && this.onOneLine(neighbour);
    }

    private onOneLine(node: Node): boolean {
        return !this.text.slice(node.offset, node.offset + node.length).includes("\n");
    }

    private rename(path: PathSegment[], from: string, to: string): Edit[] {
        const object = this.node(path);
        const keyNode = findNodeAtLocation(this.tree, [...path, from])!.parent!.children![0]!;
        const edits: Edit[] = [{ offset: keyNode.offset, length: keyNode.length, content: JSON.stringify(to) }];
        const clash = object.children!.find((property) => property.children![0]!.value === to);

        if (clash !== undefined) {
            edits.push(...this.removeElement(clash));
        }

        return edits;
    }

    /**
     * Removes a property or an array item, with its comma: its whole block when it has lines of
     * its own (its comment lines above and the comment ending its line go with it).
     */
    private removeElement(element: Node): Edit[] {
        const container = element.parent!;
        const siblings = container.children!;

        if (siblings.length === 1) {
            // The only item: the container becomes empty, written `{}` or `[]`.
            return [{ offset: container.offset + 1, length: container.length - 2, content: "" }];
        }

        const index = siblings.indexOf(element);
        const previous = siblings[index - 1];
        const next = siblings[index + 1];
        const end = element.offset + element.length;
        const afterEnd = skipTrivia(this.text, end, false);
        const hasComma = this.text[afterEnd] === ",";
        const tail = hasComma ? afterEnd + 1 : end;
        const block = this.block(element);

        if (block !== undefined) {
            const edits: Edit[] = [{ offset: block.start, length: block.end - block.start, content: "" }];

            if (next === undefined && previous !== undefined && !hasComma) {
                edits.push(...this.removeCommaAfter(previous));
            }

            return edits;
        }

        if (next !== undefined) {
            const nextOnLaterLine = this.text.slice(tail, next.offset).includes("\n");

            if (nextOnLaterLine && previous !== undefined) {
                // Keep the line break before the next item: cut from the previous item's comma.
                const start = skipTrivia(this.text, previous.offset + previous.length, false) + 1;

                return [{ offset: start, length: tail - start, content: "" }];
            }

            return [{ offset: element.offset, length: next.offset - element.offset, content: "" }];
        }

        const previousEnd = previous!.offset + previous!.length;

        return [{ offset: previousEnd, length: end - previousEnd, content: "" }];
    }

    private removeCommaAfter(element: Node): Edit[] {
        const comma = skipTrivia(this.text, element.offset + element.length, false);

        return this.text[comma] === "," ? [{ offset: comma, length: 1, content: "" }] : [];
    }

    /**
     * Inserts an entry (a `"key": value` property or an array item) at an index. In a container
     * whose entries have lines of their own, it goes in as a block of lines: right before the
     * block of the entry now at `index` (its comment lines above included), or right after the
     * entry before it, as the placement says, moved over `placement.lines` blank or comment
     * lines. Otherwise it goes in on the line, as `entry, ` or `, entry`.
     */
    private insertElement(container: Node, index: number, entry: EntryParts, placement?: Placement): Edit[] {
        const children = container.children ?? [];
        const open = container.offset;
        const close = container.offset + container.length - 1;

        if (children.length === 0) {
            const inner = this.text.slice(open + 1, close);
            const multiline = inner.includes("\n") || entry.body.includes("\n") || entry.lines || container.type === "object";

            if (multiline) {
                const indent = this.childIndent(container);

                return [{ offset: open + 1, length: close - open - 1, content: `${this.layout.eol}${this.entryText(entry, indent, false)}${this.layout.eol}${lineIndent(this.text, open)}` }];
            }

            return [{ offset: open + 1, length: close - open - 1, content: entry.body }];
        }

        const inline = !this.text.slice(open, children[children.length - 1]!.offset).includes("\n");
        const previous = index > 0 ? children[index - 1] : undefined;
        const next = children[index];
        const previousBlock = previous === undefined ? undefined : this.block(previous);
        const nextBlock = next === undefined ? undefined : this.block(next);

        if (!inline && (previous === undefined || previousBlock !== undefined) && (next === undefined || nextBlock !== undefined)) {
            return this.insertBlock(index, children.length, entry, previousBlock, nextBlock, previous, next, placement);
        }

        const body = entry.body;

        if (index < children.length) {
            const before = children[index]!;

            if (inline || !isLineStart(this.text, before.offset)) {
                return [{ offset: before.offset, length: 0, content: `${body}, ` }];
            }

            const start = lineStartOf(this.text, before.offset);

            return [{ offset: start, length: 0, content: `${this.entryText(entry, lineIndent(this.text, before.offset), true)}${this.layout.eol}` }];
        }

        const last = children[children.length - 1]!;
        const lastEnd = last.offset + last.length;
        const afterLast = skipTrivia(this.text, lastEnd, false);
        const trailingComma = this.text[afterLast] === ",";

        if (inline) {
            return trailingComma
                ? [{ offset: afterLast + 1, length: 0, content: ` ${body},` }]
                : [{ offset: lastEnd, length: 0, content: `, ${body}` }];
        }

        const indent = lineIndent(this.text, last.offset);

        // Something else follows on the last item's line (the closing bracket, say).
        return trailingComma
            ? [{ offset: afterLast + 1, length: 0, content: `${this.layout.eol}${indent}${body},` }]
            : [{ offset: lastEnd, length: 0, content: `,${this.layout.eol}${indent}${body}` }];
    }

    /** Inserts an entry as a block of lines between the blocks of its neighbours (see {@link insertElement}). */
    private insertBlock(
        index: number,
        length: number,
        entry: EntryParts,
        previousBlock: Block | undefined,
        nextBlock: Block | undefined,
        previous: Node | undefined,
        next: Node | undefined,
        placement: Placement | undefined,
    ): Edit[] {
        const lines = placement?.lines ?? 0;
        let at: number;

        if (previousBlock !== undefined && (nextBlock === undefined || placement?.from === "previous")) {
            const limit = nextBlock?.start ?? this.text.length;

            at = moveDown(this.text, previousBlock.end, lines, limit, isJsoncTrivia);
        } else {
            at = moveUp(this.text, nextBlock!.start, lines, previousBlock?.end ?? 0, isJsoncTrivia);
        }

        const indent = lineIndent(this.text, (next ?? previous)!.offset);
        const last = index === length;
        const comma = last ? previousBlock!.hasComma : true;
        const edits: Edit[] = [{ offset: at, length: 0, content: `${this.entryText(entry, indent, comma)}${this.layout.eol}` }];

        if (last && !previousBlock!.hasComma) {
            edits.unshift({ offset: previous!.offset + previous!.length, length: 0, content: "," });
        }

        return edits;
    }

    /** The indentation of a container's items: that of its first item, or one level deeper than it. */
    private childIndent(container: Node): string {
        const first = container.children?.[0];

        if (first !== undefined && isLineStart(this.text, first.offset)) {
            return lineIndent(this.text, first.offset);
        }

        return lineIndent(this.text, container.offset) + this.layout.unit;
    }

    private format(value: JsonValue, indent: string, oneLine = false): string {
        return oneLine ? oneLineText(value) : stringify(value, indent, this.layout);
    }

    private lineBreakLength(offset: number): number {
        if (this.text.startsWith("\r\n", offset)) {
            return 2;
        }

        return this.text[offset] === "\n" ? 1 : 0;
    }

    /** The line break at an offset, or the file's when there is none (the end of the text). */
    private lineBreakAt(offset: number): string {
        const length = this.lineBreakLength(offset);

        return length === 0 ? this.layout.eol : this.text.slice(offset, offset + length);
    }
}

/**
 * Reads an entry's source (see {@link EntrySource}) into its parts, or `undefined` when it is not
 * one property (or one item) with comments around it.
 */
function readParts(source: string, property: boolean): EntryParts | undefined {
    const lines = source.endsWith("\n");
    const start = skipTrivia(source, 0, false);
    const lineStart = lineStartOf(source, start);
    const errors: ParseError[] = [];
    const wrapped = `${property ? "{" : "["}${source.slice(start)}${property ? "}" : "]"}`;
    const tree = parseTree(wrapped, errors, { allowTrailingComma: true });

    if (errors.length > 0 || tree === undefined || tree.children?.length !== 1 || (!lines && start !== 0)) {
        return undefined;
    }

    const element = tree.children[0]!;
    const bodyStart = start + element.offset - 1;
    const bodyEnd = bodyStart + element.length;
    const lastLineEnd = lines ? source.length - (source.endsWith("\r\n") ? 2 : 1) : source.length;
    const rest = source.slice(bodyEnd, lastLineEnd);
    const comma = /^[ \t]*,/.exec(rest);
    const keyNode = property ? element.children![0]! : undefined;

    return {
        before: lines ? source.slice(0, lineStart) : "",
        indent: lines ? source.slice(lineStart, start) : "",
        body: source.slice(bodyStart, bodyEnd),
        between: comma === null ? "" : comma[0].slice(0, -1),
        after: comma === null ? rest : rest.slice(comma[0].length),
        lines,
        ...(keyNode === undefined ? {} : { key: { offset: keyNode.offset - element.offset, length: keyNode.length, value: keyNode.value as string } }),
    };
}

/** The value an entry's parts hold: a property's value, or the item. */
function partValue(parts: EntryParts, property: boolean): JsonValue | undefined {
    const value = parse(property ? `{${parts.body}}` : `[${parts.body}]`, [], { allowTrailingComma: true }) as JsonValue;

    if (property) {
        return isJsonObject(value) ? Object.values(value)[0] : undefined;
    }

    return Array.isArray(value) ? value[0] : undefined;
}

/** The parts with the property's key written as `key`, when it is another one. */
function withKey(parts: EntryParts, key: string): EntryParts {
    if (parts.key === undefined || parts.key.value === key) {
        return parts;
    }

    const { offset, length } = parts.key;

    return { ...parts, body: parts.body.slice(0, offset) + JSON.stringify(key) + parts.body.slice(offset + length), key: { offset, length: JSON.stringify(key).length, value: key } };
}

/** Whether a value's source text parses to exactly this value. */
function sourceReadsAs(source: string, value: JsonValue): boolean {
    const errors: ParseError[] = [];
    const parsed = parse(source, errors, { allowTrailingComma: true }) as JsonValue;

    return errors.length === 0 && JSON.stringify(parsed) === JSON.stringify(value);
}

/** Where a removed property (with its key) or array item (without) was, as a {@link RemovedJsoncText} key. */
function whereOf(path: PathSegment[], key?: string): string {
    return `${formatPath(path)}\u0000${key ?? "[]"}`;
}

/** JSON text for a value, indented to sit at `indent`. Empty containers stay `{}` and `[]`. */
function stringify(value: JsonValue, indent: string, layout: TextLayout): string {
    if (typeof value !== "object" || value === null || isEmpty(value)) {
        return JSON.stringify(value);
    }

    return JSON.stringify(value, null, layout.unit).replace(/\n/g, layout.eol + indent);
}

/**
 * JSON text for a value on one line, spaced the usual way.
 *
 * oneLineText({ id: 2, tags: ["a"] });   // '{ "id": 2, "tags": ["a"] }'
 */
function oneLineText(value: JsonValue): string {
    if (Array.isArray(value)) {
        return `[${value.map(oneLineText).join(", ")}]`;
    }

    if (isJsonObject(value)) {
        const entries = Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${oneLineText(item)}`);

        return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
    }

    return JSON.stringify(value);
}

/** Whether a parsed node is an object or a list with something in it. */
function isFilled(node: Node): boolean {
    return (node.type === "object" || node.type === "array") && (node.children?.length ?? 0) > 0;
}

function isEmpty(value: JsonValue): boolean {
    return Array.isArray(value) ? value.length === 0 : isJsonObject(value) && Object.keys(value).length === 0;
}

/** Whether a line holds nothing but whitespace and comments. */
function isJsoncTrivia(line: string): boolean {
    return /^[ \t]*(?:(?:\/\/|\/\*|\*).*)?\r?\n?$/.test(line);
}

/**
 * Moves an offset at a line start down over at most `count` lines that hold only blanks or
 * comments, never past `limit`.
 */
export function moveDown(text: string, offset: number, count: number, limit: number, trivia: (line: string) => boolean): number {
    let at = offset;

    for (let moved = 0; moved < count && at < limit; moved++) {
        const lineEnd = text.indexOf("\n", at);
        const next = lineEnd === -1 ? text.length : lineEnd + 1;

        if (next > limit || !trivia(text.slice(at, next))) {
            break;
        }

        at = next;
    }

    return at;
}

/**
 * Moves an offset at a line start up over at most `count` lines that hold only blanks or
 * comments, never above `limit`.
 */
export function moveUp(text: string, offset: number, count: number, limit: number, trivia: (line: string) => boolean): number {
    let at = offset;

    for (let moved = 0; moved < count && at > limit; moved++) {
        const start = lineStartOf(text, at - 1);

        if (start < limit || !trivia(text.slice(start, at))) {
            break;
        }

        at = start;
    }

    return at;
}

/** How many line breaks a text holds. */
export function countLines(text: string): number {
    return (text.match(/\n/g) ?? []).length;
}

/** Every line of a text that starts with `from` starts with `to` instead. */
export function reindent(text: string, from: string, to: string): string {
    return text.replace(/(^|\n)([ \t]*)/g, (match, start: string, indent: string) => (indent.startsWith(from) ? `${start}${to}${indent.slice(from.length)}` : match));
}

function lineStartOf(text: string, offset: number): number {
    // lastIndexOf with a negative start still finds a line break at 0.
    return offset <= 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
}

/** The whitespace that starts the line holding an offset. */
function lineIndent(text: string, offset: number): string {
    const start = lineStartOf(text, offset);

    return /^[ \t]*/.exec(text.slice(start, offset))![0];
}

/** Whether only whitespace comes before an offset on its line. */
function isLineStart(text: string, offset: number): boolean {
    return text.slice(lineStartOf(text, offset), offset).trim() === "";
}

/**
 * Where the line break is, when only whitespace and comments follow an offset on its line, or
 * `-1`. At the end of the text, the end of the text.
 */
function endOfLineAfter(text: string, offset: number): number {
    const stop = skipTrivia(text, offset, true);

    /* c8 ignore next 3: valid text always closes its containers after an item */
    if (stop >= text.length) {
        return text.length;
    }

    if (text[stop] === "\n") {
        return stop;
    }

    return text.startsWith("\r\n", stop) ? stop : -1;
}

/** Skips whitespace and comments; on one line only when `sameLine`. */
function skipTrivia(text: string, offset: number, sameLine: boolean): number {
    let i = offset;

    while (i < text.length) {
        const char = text[i]!;

        if (char === " " || char === "\t") {
            i++;
        } else if (char === "\n" || char === "\r") {
            if (sameLine) {
                return i;
            }

            i++;
        } else if (text.startsWith("//", i)) {
            const end = text.indexOf("\n", i);
            const lineEnd = end === -1 ? text.length : text[end - 1] === "\r" ? end - 1 : end;

            i = lineEnd;
        } else if (text.startsWith("/*", i)) {
            const end = text.indexOf("*/", i + 2);

            /* c8 ignore next: valid text closes its comments */
            i = end === -1 ? text.length : end + 2;
        } else {
            return i;
        }
    }

    /* c8 ignore next: valid text always has a closing bracket after any item */
    return i;
}
