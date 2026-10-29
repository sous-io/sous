/**
 * Documents edited as text: JSON, JSONC and YAML files, changed surgically so comments, key order
 * and formatting are kept.
 */
import type { Document } from "yaml";
import { applyPatch } from "./apply.js";
import { BaseDocument } from "./document.js";
import { getAtPath } from "./json.js";
import { detectLayout, editJsoncText, parseJsoncText, type TextLayout } from "./jsonc-text.js";
import { editYaml, parseYamlText, yamlValue } from "./yaml-text.js";
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
    private readonly yaml: Document | undefined;
    private readonly layout: TextLayout;

    constructor(text: string, readonly format: DocumentFormat) {
        super();
        this.text = text;
        this.layout = detectLayout(text);

        if (format === "yaml") {
            this.yaml = parseYamlText(text);
            this.current = yamlValue(this.yaml);
        } else {
            this.yaml = undefined;
            this.current = parseJsoncText(text);
        }
    }

    /** The current value. */
    value(): JsonValue {
        return this.current;
    }

    /** The edited text. */
    override toString(): string {
        return this.yaml === undefined ? this.text : this.yaml.toString();
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

        if (this.yaml !== undefined) {
            editYaml(this.yaml, patch);
        } else {
            this.text = editJsoncText(this.text, patch, before, after, this.layout);
        }

        this.current = after;

        return undefined;
    }
}

/**
 * Parses JSON, JSONC or YAML text into a document to edit surgically. Empty text is `{}`.
 *
 * @throws Error when the text cannot be parsed, naming where.
 */
export function parseDocument(text: string, format: DocumentFormat): TextDocument {
    return new TextDocument(text, format);
}
