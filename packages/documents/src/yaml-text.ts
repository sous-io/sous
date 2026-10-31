/**
 * Surgical edits to YAML, through the `yaml` package's document model, which keeps comments and
 * the layout of everything an edit does not touch.
 */
import { type Document, isScalar, isSeq, parseDocument, type Pair, type YAMLMap, type YAMLSeq } from "yaml";
import { parsePath } from "./path.js";
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

/** Applies one primitive (known to apply) to a YAML document in place. */
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
            (collection(doc, path) as YAMLSeq).items.splice(patch.index, 1);
            break;
        case "renameKey":
            rename(collection(doc, path) as YAMLMap, patch.key, patch.to, doc);
            break;
        case "insertAt": {
            const seq = collection(doc, path);

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

function collection(doc: Document, path: PathSegment[]): unknown {
    return doc.getIn(path, true);
}

/** Sets a value; a scalar replacing a scalar keeps the old node, and with it its comments. */
function setValue(doc: Document, path: PathSegment[], value: JsonValue): void {
    /* c8 ignore start: an insertAt that creates the root array; a parsed root always exists */
    if (path.length === 0) {
        doc.contents = doc.createNode(value) as never;

        return;
    }
    /* c8 ignore stop */

    const existing = doc.getIn(path, true);
    const isPlainScalar = value === null || typeof value !== "object";

    if (isPlainScalar && isScalar(existing)) {
        existing.value = value;

        return;
    }

    doc.setIn(path, doc.createNode(value));
}

function rename(map: YAMLMap, from: string, to: string, doc: Document): void {
    const keyOf = (pair: Pair): unknown => (isScalar(pair.key) ? pair.key.value : pair.key);
    const clash = map.items.findIndex((pair) => keyOf(pair) === to);

    if (clash !== -1) {
        map.items.splice(clash, 1);
    }

    const pair = map.items.find((item) => keyOf(item) === from)!;

    if (isScalar(pair.key)) {
        pair.key.value = to;
    } else {
        /* c8 ignore next: a complex YAML key, which a JSON path cannot name */
        pair.key = doc.createNode(to);
    }
}
