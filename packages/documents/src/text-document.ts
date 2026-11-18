/**
 * Documents edited as text: JSON, JSONC and YAML files, changed surgically so every line an edit
 * does not touch stays as it was.
 */
import { parseDocument as parseYamlModel } from "yaml";
import { applyPatch } from "./apply.js";
import { BaseDocument } from "./document.js";
import { getAtPath } from "./json.js";
import { detectLayout, editJsoncText, parseJsoncText, type RemovedJsoncText, type TextLayout } from "./jsonc-text.js";
import { detectYamlStyle, editYamlText, parseYamlText, reprintYaml, yamlValue, type RemovedText, type YamlStyle } from "./yaml-text.js";
import type { DocumentFormat, JsonValue, Patch, PatchProblem, PathSegment } from "./types.js";

/**
 * A text document. Every change goes through primitives: each is first applied to the value (a
 * patch that cannot apply is reported and leaves the text alone), then made to the text.
 *
 * ```ts
 * const doc = parseDocument(fs.readFileSync(".sous/conf.d/510-subscriptions.jsonc", "utf8"), "jsonc");
 *
 * doc.atPath(["subscriptions", "workflow/x", "enabled"]).set(false);
 * fs.writeFileSync(file, doc.toString());   // comments and layout kept
 * ```
 */
export class TextDocument extends BaseDocument {
    private current: JsonValue;
    private text: string;
    private readonly original: string;
    private readonly layout: TextLayout;
    private readonly yamlStyle: YamlStyle | undefined;
    /** The text of keys and items YAML edits removed, reused when the same value is put back. */
    private readonly removed: RemovedText[] = [];
    private readonly removedJsonc: RemovedJsoncText[] = [];
    private edited = false;
    private reprints = 0;

    constructor(text: string, readonly format: DocumentFormat) {
        super();
        this.original = text;

        this.text = text;
        this.layout = detectLayout(text);

        if (format === "yaml") {
            this.current = yamlValue(parseYamlText(text));
            this.yamlStyle = detectYamlStyle(text);
        } else {
            this.current = parseJsoncText(text);
            this.yamlStyle = undefined;
        }
    }

    /** The current value. */
    value(): JsonValue {
        return this.current;
    }

    /** The edited text. Until something changes, the original text, byte for byte. */
    override toString(): string {
        if (!this.edited) {
            return this.original;
        }

        return this.text;
    }

    /**
     * Whether an edit to this YAML document could not be made surgically, so the whole document
     * was reprinted (comments kept, spacing and layout possibly changed). Always `false` for JSON.
     */
    reprinted(): boolean {
        return this.reprints > 0;
    }

    protected readAt(path: readonly PathSegment[]): JsonValue | undefined {
        return getAtPath(this.current, path);
    }

    protected applyPrimitive(patch: Patch): PatchProblem | undefined {
        let problem: PatchProblem | undefined;
        let changed = false;
        const before = this.current;
        const after = applyPatch(before, patch, {
            onProblem: (found) => (problem = found),
            onApplied: () => (changed = true),
        });

        if (!changed || after === undefined) {
            return problem;
        }

        this.text = this.yamlStyle === undefined
            ? editJsoncText(this.text, patch, before, after, this.layout, this.removedJsonc)
            : this.editYaml(patch, after, this.yamlStyle);
        this.current = after;
        this.edited = true;

        return undefined;
    }

    /**
     * Edits the YAML text surgically, and checks the result reads back as the expected value.
     * When it cannot, or the check fails, reprints the whole document instead.
     */
    private editYaml(patch: Patch, after: JsonValue, style: YamlStyle): string {
        const surgical = editYamlText(this.text, patch, after, style, this.removed);

        if (surgical !== undefined && readsAs(surgical, after)) {
            return surgical;
        }

        this.reprints++;

        return reprintYaml(this.text, patch);
    }
}

/** Whether YAML text parses, as one document, to exactly this value, key order included. */
function readsAs(text: string, value: JsonValue): boolean {
    const doc = parseYamlModel(text);

    if (doc.errors.length > 0) {
        return false;
    }

    return JSON.stringify(doc.toJS() ?? {}) === JSON.stringify(value);
}

/**
 * Parses JSON, JSONC or YAML text into a document to edit surgically. Empty text is `{}`.
 *
 * @throws Error when the text cannot be parsed, naming where.
 */
export function parseDocument(text: string, format: DocumentFormat): TextDocument {
    return new TextDocument(text, format);
}
