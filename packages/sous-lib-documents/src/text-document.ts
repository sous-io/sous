/**
 * Documents edited as text: JSON, JSONC and YAML files, and the YAML frontmatter of Markdown
 * files, changed surgically so every line an edit does not touch stays as it was.
 */
import { parseDocument as parseYamlModel } from "yaml";
import { applyPatch } from "./apply.js";
import { commentSource, readComment, removeComment, restoreCommentSource, setComment, type CommentFormat, type CommentPlace } from "./comments.js";
import { BaseDocument } from "./document.js";
import { joinFrontmatter, splitFrontmatter, type FrontmatterParts } from "./frontmatter.js";
import { getAtPath } from "./json.js";
import { formatPath, parsePath } from "./path.js";
import { detectLayout, editJsoncText, parseJsoncText, type RemovedJsoncText, type TextLayout } from "./jsonc-text.js";
import { detectYamlStyle, editYamlText, parseYamlText, reprintYaml, yamlValue, type RemovedText, type YamlStyle } from "./yaml-text.js";
import type { DocumentFormat, JsonValue, Patch, PatchProblem, PathInput, PathSegment } from "./types.js";

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
