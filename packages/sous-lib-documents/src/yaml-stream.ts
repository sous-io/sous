/**
 * A YAML file holding several documents separated by `---` lines (a Kubernetes manifest, say).
 * `parseDocument(text, "yaml")` refuses such a file ("Source contains multiple documents"), since a
 * path cannot say which document it means. A stream opens one document at a time by its index,
 * edits it surgically like any YAML document, and writes the whole file back with every other
 * document, and every `---` line, byte for byte as it was.
 *
 * ```ts
 * const stream = parseYamlStream("kind: Service\n---\nkind: Deployment\nspec:\n  replicas: 1\n");
 *
 * stream.count();                                        // 2
 * stream.document(1).atPath("spec.replicas").set(3);
 * stream.toString();   // "kind: Service\n---\nkind: Deployment\nspec:\n  replicas: 3\n"
 * ```
 */
import { parseAllDocuments } from "yaml";
import { TextDocument } from "./text-document.js";

/** One document of the stream: the text before its content (comments, directives, the `---` line) and its content. */
interface Segment {
    prefix: string;
    body: string;
    doc: TextDocument | undefined;
}

/** A line that starts a document: `---` alone, or followed by a space. */
const START = /^---(?:[ \t]|\r?\n|$)/;
/** A line that ends a document: `...`. */
const END = /^\.\.\.(?:[ \t]|\r?\n|$)/;

/** The several documents of one YAML text. */
export class YamlStream {
    private readonly segments: Segment[];

    /** @throws Error when a document cannot be parsed, or the text cannot be cut into its documents. */
    constructor(private readonly original: string) {
        this.segments = split(original);

        const parsed = parseAllDocuments(original);

        if (!Array.isArray(parsed)) {
            throw new Error("The YAML text is not valid.");
        }

        const problem = parsed.flatMap((doc) => doc.errors)[0];

        if (problem !== undefined) {
            throw new Error(`The YAML text is not valid: ${problem.message}`);
        }

        if (parsed.length > 0 && parsed.length !== this.segments.length) {
            throw new Error(`The YAML text holds ${parsed.length} documents, but Sous could not tell where each starts.`);
        }
    }

    /** How many documents the stream holds. An empty text is one empty document. */
    count(): number {
        return this.segments.length;
    }

    /**
     * One document, by its index from 0, to read and edit like any YAML document. The same index
     * gives the same document each time.
     *
     * @throws RangeError when the stream has no document at that index.
     */
    document(index: number): TextDocument {
        const segment = this.segments[index];

        if (!Number.isInteger(index) || segment === undefined) {
            const count = this.segments.length;

            throw new RangeError(`The YAML file holds ${count} document${count === 1 ? "" : "s"}, so it has no document ${index} (they count from 0).`);
        }

        segment.doc ??= new TextDocument(segment.body, "yaml");

        return segment.doc;
    }

    /** The whole text: each document's edited text, the others byte for byte. Unchanged, the original. */
    toString(): string {
        if (this.segments.every((segment) => segment.doc === undefined)) {
            return this.original;
        }

        return this.segments.map((segment) => segment.prefix + (segment.doc === undefined ? segment.body : segment.doc.toString())).join("");
    }
}

/**
 * Parses a YAML text holding one or more documents. A text with one document (no `---` line
 * between documents) is a stream of one, whose document 0 is what `parseDocument(text, "yaml")`
 * gives.
 *
 * @throws Error when the text cannot be parsed.
 */
export function parseYamlStream(text: string): YamlStream {
    return new YamlStream(text);
}

/** Whether a line holds only spaces, a comment, or a directive (`%YAML 1.2`): no content. */
function isQuiet(line: string): boolean {
    const trimmed = line.trim();

    return trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("%");
}

/**
 * Cuts a text into its documents. A `---` line starts one: the line goes in its prefix, with the
 * quiet lines before it that belong to no document (when a `---` line has content after it, only
 * `---` goes in the prefix). A document with no `---` line starts at its first line of content,
 * and the quiet lines before that are part of it. A `...` line ends a document.
 */
function split(text: string): Segment[] {
    const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const segments: Segment[] = [];
    let current: Segment | undefined;
    let pending = "";

    for (const line of lines) {
        if (START.test(line)) {
            if (current !== undefined) segments.push(current);

            const rest = line.slice(3);
            const onlyMarker = isQuiet(rest);

            current = { prefix: pending + (onlyMarker ? line : "---"), body: onlyMarker ? "" : rest, doc: undefined };
            pending = "";
        } else if (END.test(line) && current !== undefined) {
            current.body += line;
            segments.push(current);
            current = undefined;
        } else if (current !== undefined) {
            current.body += line;
        } else if (isQuiet(line)) {
            pending += line;
        } else {
            current = { prefix: "", body: pending + line, doc: undefined };
            pending = "";
        }
    }

    if (current !== undefined) {
        segments.push(current);
    } else if (pending !== "") {
        // Quiet lines after the last document's `...`, or a text with no content at all.
        if (segments.length === 0) {
            segments.push({ prefix: "", body: pending, doc: undefined });
        } else {
            segments[segments.length - 1]!.body += pending;
        }
    }

    if (segments.length === 0) {
        segments.push({ prefix: "", body: "", doc: undefined });
    }

    return segments;
}
