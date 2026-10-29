/**
 * Surgical edits to JSON and JSONC text. Offsets come from jsonc-parser's syntax tree; the edits
 * themselves are computed here, line by line, so comments, key order and the file's own layout
 * survive and nothing around an edit is reformatted.
 */
import { applyEdits, findNodeAtLocation, parse, parseTree, type Edit, type Node, type ParseError } from "jsonc-parser";
import { child, getAtPath, isJsonObject } from "./json.js";
import { parsePath } from "./path.js";
import type { JsonValue, Patch, PathSegment } from "./types.js";

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
 * Applies one primitive to JSON or JSONC text. `before` is the document's value before the patch
 * and `after` its value after; the patch is known to apply.
 */
export function editJsoncText(text: string, patch: Patch, before: JsonValue | undefined, after: JsonValue, layout: TextLayout): string {
    const tree = text.trim() === "" ? undefined : parseTree(text, [], { allowTrailingComma: true });

    if (tree === undefined) {
        return stringify(after, "", layout) + layout.eol;
    }

    const editor = new JsoncEditor(text, tree, layout);
    const path = parsePath(patch.path);

    return applyEdits(text, editor.edits(patch, path, before));
}

/** Computes the text edits for one primitive. */
class JsoncEditor {
    constructor(private readonly text: string, private readonly tree: Node, private readonly layout: TextLayout) {}

    edits(patch: Patch, path: PathSegment[], before: JsonValue | undefined): Edit[] {
        switch (patch.op) {
            case "setKey":
                return this.setAt([...path, patch.key], patch.value, before);
            case "setIndex":
                return this.replaceValue(this.node([...path, patch.index]), patch.value);
            case "deleteKey":
            case "removeIndex": {
                const target = this.node([...path, patch.op === "deleteKey" ? patch.key : patch.index]);

                return this.removeElement(patch.op === "deleteKey" ? target.parent! : target);
            }
            case "renameKey":
                return this.rename(path, patch.key, patch.to);
            case "insertAt": {
                const container = findNodeAtLocation(this.tree, path);

                if (container === undefined) {
                    return this.createMissing(path, [patch.value], before);
                }

                const length = container.children?.length ?? 0;
                const index = patch.index === "end" ? length : patch.index;

                return this.insertElement(container, index, this.format(patch.value, this.childIndent(container)));
            }
        }
    }

    private node(path: PathSegment[]): Node {
        return path.length === 0 ? this.tree : findNodeAtLocation(this.tree, path)!;
    }

    /** Sets a key: replaces an existing value, or adds the key (creating missing objects). */
    private setAt(path: PathSegment[], value: JsonValue, before: JsonValue | undefined): Edit[] {
        const existing = findNodeAtLocation(this.tree, path);

        if (existing !== undefined) {
            return this.replaceValue(existing, value);
        }

        return this.createMissing(path.slice(0, -1), value, before, path[path.length - 1] as string);
    }

    /**
     * Adds a value at a path whose end is missing: finds the deepest object that exists and adds
     * one key to it, holding the missing objects nested around the value.
     */
    private createMissing(path: PathSegment[], value: JsonValue, before: JsonValue | undefined, key?: string): Edit[] {
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
        const entry = `${JSON.stringify(missing[0])}: ${this.format(nested, this.childIndent(container))}`;

        return this.insertElement(container, container.children?.length ?? 0, entry);
    }

    private replaceValue(node: Node, value: JsonValue): Edit[] {
        return [{ offset: node.offset, length: node.length, content: this.format(value, lineIndent(this.text, node.offset)) }];
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

    /** Removes a property or an array item, with its comma, and its line when it has one to itself. */
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
        const ownLine = isLineStart(this.text, element.offset) && endOfLineAfter(this.text, tail) !== -1;

        if (ownLine) {
            const start = lineStartOf(this.text, element.offset);
            const stop = endOfLineAfter(this.text, tail) + this.lineBreakLength(endOfLineAfter(this.text, tail));
            const edits: Edit[] = [{ offset: start, length: stop - start, content: "" }];

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

    /** Inserts an element's text (a `"key": value` entry or an array item) at an index. */
    private insertElement(container: Node, index: number, entry: string): Edit[] {
        const children = container.children ?? [];
        const open = container.offset;
        const close = container.offset + container.length - 1;

        if (children.length === 0) {
            const inner = this.text.slice(open + 1, close);

            if (inner.includes("\n")) {
                const indent = this.childIndent(container);

                return [{ offset: open + 1, length: close - open - 1, content: `${this.layout.eol}${indent}${entry}${this.layout.eol}${lineIndent(this.text, open)}` }];
            }

            const multiline = entry.includes("\n") || container.type === "object";

            if (multiline) {
                const indent = this.childIndent(container);

                return [{ offset: open + 1, length: close - open - 1, content: `${this.layout.eol}${indent}${entry}${this.layout.eol}${lineIndent(this.text, open)}` }];
            }

            return [{ offset: open + 1, length: close - open - 1, content: entry }];
        }

        const inline = !this.text.slice(open, children[children.length - 1]!.offset).includes("\n");

        if (index < children.length) {
            const before = children[index]!;

            if (inline || !isLineStart(this.text, before.offset)) {
                return [{ offset: before.offset, length: 0, content: `${entry}, ` }];
            }

            const start = lineStartOf(this.text, before.offset);

            return [{ offset: start, length: 0, content: `${lineIndent(this.text, before.offset)}${entry},${this.layout.eol}` }];
        }

        const last = children[children.length - 1]!;
        const lastEnd = last.offset + last.length;
        const afterLast = skipTrivia(this.text, lastEnd, false);
        const trailingComma = this.text[afterLast] === ",";

        if (inline) {
            return trailingComma
                ? [{ offset: afterLast + 1, length: 0, content: ` ${entry},` }]
                : [{ offset: lastEnd, length: 0, content: `, ${entry}` }];
        }

        const lineEnd = endOfLineAfter(this.text, trailingComma ? afterLast + 1 : lastEnd);
        const indent = lineIndent(this.text, last.offset);

        if (lineEnd === -1) {
            // Something else follows on the last item's line (the closing bracket, say).
            return trailingComma
                ? [{ offset: afterLast + 1, length: 0, content: `${this.layout.eol}${indent}${entry},` }]
                : [{ offset: lastEnd, length: 0, content: `,${this.layout.eol}${indent}${entry}` }];
        }

        const edits: Edit[] = [{ offset: lineEnd, length: 0, content: `${this.layout.eol}${indent}${entry}${trailingComma ? "," : ""}` }];

        if (!trailingComma) {
            edits.unshift({ offset: lastEnd, length: 0, content: "," });
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

    private format(value: JsonValue, indent: string): string {
        return stringify(value, indent, this.layout);
    }

    private lineBreakLength(offset: number): number {
        if (this.text.startsWith("\r\n", offset)) {
            return 2;
        }

        return this.text[offset] === "\n" ? 1 : 0;
    }
}

/** JSON text for a value, indented to sit at `indent`. Empty containers stay `{}` and `[]`. */
function stringify(value: JsonValue, indent: string, layout: TextLayout): string {
    if (typeof value !== "object" || value === null || isEmpty(value)) {
        return JSON.stringify(value);
    }

    return JSON.stringify(value, null, layout.unit).replace(/\n/g, layout.eol + indent);
}

function isEmpty(value: JsonValue): boolean {
    return Array.isArray(value) ? value.length === 0 : isJsonObject(value) && Object.keys(value).length === 0;
}

function lineStartOf(text: string, offset: number): number {
    return text.lastIndexOf("\n", offset - 1) + 1;
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
