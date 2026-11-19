/**
 * Documents edited as text: JSON, JSONC and YAML files, and the YAML frontmatter of Markdown
 * files, changed surgically so every line an edit does not touch stays as it was.
 */
import { parseDocument as parseYamlModel } from "yaml";
import { applyPatch, applyPatches } from "./apply.js";
import { commentSource, readComment, removeComment, restoreCommentSource, setComment, type CommentFormat, type CommentPlace } from "./comments.js";
import { BaseDocument } from "./document.js";
import { joinFrontmatter, splitFrontmatter, type FrontmatterParts } from "./frontmatter.js";
import { getAtPath } from "./json.js";
import { formatPath, parsePath } from "./path.js";
import {
    detectLayout,
    editJsoncText,
    jsoncEntrySource,
    jsoncValueSource,
    parseJsoncText,
    reorderJsoncText,
    type RemovedJsoncText,
    type TextLayout,
} from "./jsonc-text.js";
import {
    detectYamlStyle,
    editYamlText,
    parseYamlText,
    reorderYamlText,
    reprintYaml,
    yamlEntrySource,
    yamlValue,
    yamlValueSource,
    type RemovedText,
    type YamlStyle,
} from "./yaml-text.js";
import type { DocumentFormat, EntrySource, JsonValue, Patch, PatchProblem, PathInput, PathSegment, Placement } from "./types.js";

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
 *
 * A `markdown` document is the YAML frontmatter of a Markdown file; the body is never changed:
 *
 * ```ts
 * const doc = parseDocument("---\nmodel: sonnet\n---\n# Reviewer\n", "markdown");
 *
 * doc.atPath("model").set("opus");
 * doc.toString();   // "---\nmodel: opus\n---\n# Reviewer\n"
 * ```
 */
export class TextDocument extends BaseDocument {
    private current: JsonValue;
    /** The text being edited: the whole file, or a Markdown file's frontmatter YAML. */
    private text: string;
    private readonly original: string;
    private readonly layout: TextLayout;
    private readonly yamlStyle: YamlStyle | undefined;
    private readonly frontmatter: FrontmatterParts | undefined;
    /** The text of keys and items YAML edits removed, reused when the same value is put back. */
    private readonly removed: RemovedText[] = [];
    private readonly removedJsonc: RemovedJsoncText[] = [];
    private edited = false;
    private reprints = 0;

    constructor(text: string, readonly format: DocumentFormat) {
        super();
        this.original = text;

        if (format === "markdown") {
            this.frontmatter = splitFrontmatter(text);
            this.text = this.frontmatter.yaml ?? "";
        } else {
            this.frontmatter = undefined;
            this.text = text;
        }

        this.layout = detectLayout(this.text);

        if (format === "yaml" || format === "markdown") {
            this.current = yamlValue(parseYamlText(this.text));
            this.yamlStyle = detectYamlStyle(this.frontmatter === undefined ? this.text : this.frontmatter.yaml ?? this.frontmatter.body);
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

        return this.frontmatter === undefined ? this.text : joinFrontmatter(this.frontmatter, this.text);
    }

    /**
     * Whether an edit to this YAML document could not be made surgically, so the whole document
     * was reprinted (comments kept, spacing and layout possibly changed). Always `false` for JSON.
     */
    reprinted(): boolean {
        return this.reprints > 0;
    }

    /**
     * The comment before or after a key or list item (see `comments.ts`), markers taken off, or
     * `undefined` when it has none. A Markdown document reads its frontmatter's comments.
     *
     * @throws CommentError for JSON, which has no comments, and for a node that shares its line.
     */
    comment(path: PathInput, place: CommentPlace): string | undefined {
        return readComment(this.text, this.commentFormat(), path, place);
    }

    /** The comment before or after a node exactly as written, to put back with {@link restoreCommentSource}. */
    commentSource(path: PathInput, place: CommentPlace): string {
        return commentSource(this.text, this.commentFormat(), path, place);
    }

    /** Sets (adds or replaces) the comment before or after a node. Only the comment's bytes change. */
    setComment(path: PathInput, place: CommentPlace, comment: string): void {
        this.editComment(setComment(this.text, this.commentFormat(), path, place, comment));
    }

    /** Removes the comment before or after a node, if it has one. */
    removeComment(path: PathInput, place: CommentPlace): void {
        this.editComment(removeComment(this.text, this.commentFormat(), path, place));
    }

    /** Puts back what {@link commentSource} returned, byte for byte. */
    restoreCommentSource(path: PathInput, place: CommentPlace, source: string): void {
        this.editComment(restoreCommentSource(this.text, this.commentFormat(), path, place, source));
    }

    private commentFormat(): CommentFormat {
        return this.format === "markdown" ? "yaml" : this.format;
    }

    private editComment(text: string): void {
        if (text !== this.text) {
            this.text = text;
            this.edited = true;
        }
    }

    protected readAt(path: readonly PathSegment[]): JsonValue | undefined {
        return getAtPath(this.current, path);
    }

    protected override reorderEntries(path: readonly PathSegment[], order: readonly number[], patches: readonly Patch[]): boolean {
        const after = applyPatches(this.current, patches);
        const text = this.yamlStyle === undefined
            ? reorderJsoncText(this.text, [...path], order)
            : reorderYamlText(this.text, [...path], order, this.yamlStyle);

        return after !== undefined && text !== undefined && this.commit(text, after, patches);
    }

    protected override placeEntry(
        path: readonly PathSegment[],
        key: string | undefined,
        value: JsonValue,
        placement: Placement,
        source: string | undefined,
        patches: readonly Patch[],
    ): boolean {
        const after = applyPatches(this.current, patches);
        const where = formatPath(path);
        const patch: Patch = key === undefined ? { op: "insertAt", path: where, index: placement.index, value } : { op: "setKey", path: where, key, value };

        if (after === undefined) {
            return false;
        }

        // The source first; then new text, in case the source does not read as the value.
        for (const text of [source, undefined]) {
            const options = { placement, ...(text === undefined ? {} : { source: text }) };
            let edited: string | undefined;

            try {
                edited = this.yamlStyle === undefined
                    ? editJsoncText(this.text, patch, this.current, after, this.layout, this.removedJsonc, options)
                    : editYamlText(this.text, patch, after, this.yamlStyle, this.removed, options);
            } catch {
                edited = undefined;
            }

            if (edited !== undefined && this.commit(edited, after, patches)) {
                return true;
            }

            if (source === undefined) {
                break;
            }
        }

        if (this.yamlStyle !== undefined) {
            const reprinted = reprintYaml(this.text, patch, key === undefined ? undefined : placement.index);

            if (this.commit(reprinted, after, patches)) {
                this.reprints++;

                return true;
            }
        }

        return false;
    }

    protected override entrySourceAt(path: readonly PathSegment[]): EntrySource | undefined {
        if (path.length === 0 || getAtPath(this.current, path) === undefined) {
            return undefined;
        }

        return this.yamlStyle === undefined ? jsoncEntrySource(this.text, [...path]) : yamlEntrySource(this.text, [...path], this.yamlStyle);
    }

    protected override valueSourceAt(path: readonly PathSegment[]): string | undefined {
        if (getAtPath(this.current, path) === undefined) {
            return undefined;
        }

        return this.yamlStyle === undefined ? jsoncValueSource(this.text, [...path]) : yamlValueSource(this.text, [...path], this.yamlStyle);
    }

    protected override setFromSource(patch: Patch, source: string): boolean {
        if (patch.op !== "setKey" && patch.op !== "setIndex") {
            return false;
        }

        const after = applyPatch(this.current, patch);
        const target = patch.op === "setKey" ? [...parsePath(patch.path), patch.key] : [...parsePath(patch.path), patch.index];

        if (after === undefined || getAtPath(this.current, target) === undefined) {
            return false;
        }

        let edited: string | undefined;

        try {
            edited = this.yamlStyle === undefined
                ? editJsoncText(this.text, patch, this.current, after, this.layout, this.removedJsonc, { source })
                : editYamlText(this.text, patch, after, this.yamlStyle, this.removed, { source });
        } catch {
            edited = undefined;
        }

        return edited !== undefined && this.commit(edited, after, [patch]);
    }

    /**
     * Takes an edited text when it reads as exactly the expected value (key order included), and
     * records the primitives that made the change. Returns whether it took it.
     */
    private commit(text: string, after: JsonValue, patches: readonly Patch[]): boolean {
        if (!(this.yamlStyle === undefined ? jsoncReadsAs(text, after) : readsAs(text, after))) {
            return false;
        }

        this.text = text;
        this.current = after;
        this.edited = true;
        this.recordApplied(patches);

        return true;
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
     * When it cannot, or the check fails, reprints the whole document instead, and checks that.
     *
     * @throws Error when neither text reads back as the expected value: an edit to a value a YAML
     *   anchor (`&name`) shares with its aliases (`*name`), which would change every copy.
     */
    private editYaml(patch: Patch, after: JsonValue, style: YamlStyle): string {
        let surgical: string | undefined;

        try {
            surgical = editYamlText(this.text, patch, after, style, this.removed);
        } catch {
            // A path through an alias, say, which the text editor does not follow.
            surgical = undefined;
        }

        if (surgical !== undefined && readsAs(surgical, after)) {
            return surgical;
        }

        let reprinted: string | undefined;
        let cause: unknown;

        try {
            reprinted = reprintYaml(this.text, patch);
        } catch (error) {
            cause = error;
        }

        if (reprinted === undefined || !readsAs(reprinted, after)) {
            throw new Error(`The YAML document cannot be edited at ${describeTarget(patch)}: the value there is shared `
                + "through a YAML anchor (&name) and its aliases (*name), or reached through one, so it cannot be changed in one place.",
            cause === undefined ? undefined : { cause });
        }

        this.reprints++;

        return reprinted;
    }
}

/** Where a primitive acts, as a path for a message. */
function describeTarget(patch: Patch): string {
    const last = "key" in patch ? patch.key : "index" in patch ? patch.index : undefined;
    const where = last === undefined ? patch.path : formatPath([...parsePath(patch.path), ...(last === "end" ? [] : [last])]);

    return where === "" ? "the root" : where;
}

/** Whether JSON or JSONC text parses to exactly this value, key order included. */
function jsoncReadsAs(text: string, value: JsonValue): boolean {
    try {
        return JSON.stringify(parseJsoncText(text)) === JSON.stringify(value);
    } catch {
        return false;
    }
}

/** Whether YAML text parses, as one document, to exactly this value, key order included. */
function readsAs(text: string, value: JsonValue): boolean {
    const doc = parseYamlModel(text);

    if (doc.errors.length > 0) {
        return false;
    }

    try {
        return JSON.stringify(doc.toJS() ?? {}) === JSON.stringify(value);
    } catch {
        // An alias whose anchor the edit removed.
        return false;
    }
}

/**
 * Parses JSON, JSONC, YAML, or the YAML frontmatter of a Markdown file, into a document to edit
 * surgically. Empty text, and a Markdown file with no frontmatter, is `{}`.
 *
 * @throws Error when the text cannot be parsed, naming where.
 */
export function parseDocument(text: string, format: DocumentFormat): TextDocument {
    return new TextDocument(text, format);
}
