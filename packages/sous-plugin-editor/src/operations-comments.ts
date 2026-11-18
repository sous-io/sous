/**
 * The comment operations of spec 07 ("The Operations": `setCommentBefore`, `setCommentAfter`,
 * `removeComment`), defined once each like the operations in `operations.ts`, which registers them.
 *
 * A comment belongs to a key or a list item: the comment lines directly above it ("before") and
 * the comment ending its line ("after"). The library (`@sous-io/sous-lib-documents`, `comments.ts`)
 * does the editing, surgically: only the comment's own bytes change. JSONC, YAML and a Markdown
 * file's frontmatter have comments; plain JSON has none, so an operation on a `.json` file is
 * skipped with a warning.
 *
 * ```yaml
 * edits:
 *   - file: .claude/agents/reviewer.md
 *     setCommentBefore:
 *       path: model
 *       text: Chosen by the platform team; ask before changing it.
 * ```
 *
 * `up` records the comment exactly as it was written (`source`), and `down` puts those bytes
 * back, so removing the declaration leaves the file as it was before Sous first acted.
 *
 * Also here: spec 07's `selectDocument`, a YAML file holding several documents. It is the
 * `document: <index>` parameter every operation takes beside `path` ({@link inDocument}), and
 * the chain's `selectDocument(index)` ({@link addSelectDocument}).
 *
 * Every function here is a function declaration: `operations.ts` calls them while it loads, which
 * may be before this module's own body has run.
 */

import { CommentError, isJsonObject, type CommentPlace, type JsonObject, type JsonValue } from "@sous-io/sous-lib-documents";
import { NoSuchDocumentError, type DocumentComments, type EditableDocument } from "./documents-adapter.js";
import { ALIASES, EditNotPossible, OPERATIONS, OperationParamsError, type OperationContext, type OperationDefinition } from "./operations.js";
import type { FileSession } from "./session.js";

/** An operation as `define` in `operations.ts` takes it. */
export type OperationDraft = Omit<OperationDefinition, "normalize"> & { normalize?: (raw: JsonObject) => JsonObject };

/** The comment operations, for `operations.ts` to define. */
export function commentOperations(): OperationDraft[] {
    return [setCommentOperation("before"), setCommentOperation("after"), removeCommentOperation()];
}

/** `setCommentBefore` or `setCommentAfter`: the comment there reads `text`. */
function setCommentOperation(place: CommentPlace): OperationDraft {
    const name = place === "before" ? "setCommentBefore" : "setCommentAfter";

    return {
        name,
        // After every operation that adds or moves keys and items.
        order: 100,
        scope: "document",
        summary: place === "before"
            ? "The key or list item at `path` has this comment on the lines directly above it, indented like it; `text` may have several lines. The comment there is replaced, or one is added."
            : "The key or list item at `path` has this comment at the end of its line (one line). The comment there is replaced, or one is added.",
        params: ["text"],
        args: ["text"],
        normalize(raw) {
            commentPath(raw, name);

            if (typeof raw.text !== "string") {
                throw new OperationParamsError(`'${name}' needs 'text', the comment's words (without # or //).`);
            }

            if (place === "after" && /\r?\n/.test(raw.text)) {
                throw new OperationParamsError(`'${name}': a comment after a value is one line; use setCommentBefore for several.`);
            }

            return raw;
        },
        up(ctx, params): JsonValue {
            const comments = commentsOf(ctx, params, name);
            const text = params.text as string;

            return onComment(name, (): JsonValue => {
                if (sameWords(comments.comment(ctx.path, place), text)) {
                    return { changed: false };
                }

                const source = comments.commentSource(ctx.path, place);

                comments.setComment(ctx.path, place, text);

                return { changed: true, source };
            });
        },
        down(ctx, params, record) {
            if (isJsonObject(record) && record.changed === true && typeof record.source === "string") {
                const comments = commentsOf(ctx, params, name);

                onComment(name, () => comments.restoreCommentSource(ctx.path, place, record.source as string));
            }
        },
        mergeRecords: keepEarlier,
        // No check reads comments, and an assertion that cannot fail says nothing: none is implied.
        assertions: () => [],
    };
}

/** `removeComment`: the key or list item has no comment before it, after it, or either. */
function removeCommentOperation(): OperationDraft {
    const name = "removeComment";
    const placesOf = (params: JsonObject): CommentPlace[] => {
        const neither = params.before === undefined && params.after === undefined;

        return (["before", "after"] as const).filter((place) => neither || params[place] === true);
    };

    return {
        name,
        order: 100,
        scope: "document",
        summary: "The key or list item at `path` has no comment: before it (`before: true`), after it (`after: true`), or, with neither, both.",
        params: ["before", "after"],
        args: [],
        normalize(raw) {
            commentPath(raw, name);

            for (const place of ["before", "after"]) {
                if (raw[place] !== undefined && typeof raw[place] !== "boolean") {
                    throw new OperationParamsError(`'${name}': '${place}' must be true or false.`);
                }
            }

            if (raw.before === false && raw.after === false) {
                throw new OperationParamsError(`'${name}' with before and after both false removes nothing.`);
            }

            return raw;
        },
        up(ctx, params): JsonValue {
            const comments = commentsOf(ctx, params, name);

            return onComment(name, (): JsonValue => {
                const removed: JsonObject = {};

                for (const place of placesOf(params)) {
                    if (comments.comment(ctx.path, place) !== undefined) {
                        removed[place] = comments.commentSource(ctx.path, place);
                        comments.removeComment(ctx.path, place);
                    }
                }

                return Object.keys(removed).length === 0 ? { changed: false } : { changed: true, ...removed };
            });
        },
        down(ctx, params, record) {
            if (!isJsonObject(record) || record.changed !== true) {
                return;
            }

            const comments = commentsOf(ctx, params, name);

            for (const place of ["before", "after"] as const) {
                const source = record[place];

                if (typeof source === "string") {
                    onComment(name, () => comments.restoreCommentSource(ctx.path, place, source));
                }
            }
        },
        // A comment removed in an earlier run is kept; one added since and removed now joins it.
        mergeRecords(previous, next) {
            if (!isJsonObject(previous) || previous.changed !== true) return next;
            if (!isJsonObject(next) || next.changed !== true) return previous;

            return { ...next, ...previous };
        },
        assertions: () => [],
    };
}

// ---------------------------------------------------------------------------------------------
// selectDocument: one document of a YAML file holding several
// ---------------------------------------------------------------------------------------------

/**
 * `document: <index>` on any operation that acts on a value or a comment: the operation acts on
 * that document (from 0) of a YAML file holding several documents separated by `---` lines, and
 * every other document stays byte for byte as it was. It sits inside the operation's object, as
 * `path` does, so it is kept in the history with the operation's parameters and the undo acts
 * on the same document. The chain's `selectDocument(index)` writes it on every operation.
 *
 * ```yaml
 * edits:
 *   - file: deploy/web.yaml
 *     set:
 *       document: 1
 *       path: spec.replicas
 *       value: 3
 * ```
 *
 * `operations.ts` wraps every operation it defines with this: the parameter is checked, `up` and
 * `down` are given the node in that document, and no automatic assertion is implied (an
 * assertion reads the whole file, which a stream of several documents is not).
 */
export function inDocument(definition: OperationDefinition): OperationDefinition {
    return {
        ...definition,
        normalize(raw) {
            const params = definition.normalize(raw);

            checkDocument(params, definition);

            return params;
        },
        up: (ctx, params, previous) => definition.up(selected(ctx, params), params, previous),
        down: (ctx, params, record) => definition.down(selected(ctx, params), params, record),
        assertions: (params, path) => (params.document === undefined ? definition.assertions(params, path) : []),
    };
}

/** The operations that edit a file's whole text when they act at the root: one document of it is not text of its own. */
function editsWholeText(name: string): boolean {
    return ["ensureLine", "removeLine", "ensureBlock", "appendText", "prependText", "replaceText", "replacePattern"].includes(name);
}

/** Checks `document`: a whole number from 0, on an operation that acts inside a document. */
function checkDocument(params: JsonObject, definition: OperationDefinition): void {
    const document = params.document;

    if (document === undefined) {
        return;
    }

    if (typeof document !== "number" || !Number.isInteger(document) || document < 0) {
        throw new OperationParamsError(`'${definition.name}': 'document' must be a whole number from 0 (the first document of the file is 0).`);
    }

    if (definition.scope !== "document") {
        throw new OperationParamsError(`'${definition.name}' acts on the whole file, so it takes no 'document'.`);
    }

    if (editsWholeText(definition.name) && (typeof params.path !== "string" || params.path === "")) {
        throw new OperationParamsError(`'${definition.name}' at the root edits the whole file's text, so it takes no 'document'; give the 'path' of a string in that document.`);
    }
}

/** The context of an operation with `document`: its node is in that document. */
function selected(ctx: OperationContext, params: JsonObject): OperationContext {
    if (params.document === undefined) {
        return ctx;
    }

    const index = params.document as number;

    return { session: ctx.session, path: ctx.path, node: () => documentAt(ctx.session, index).atPath(ctx.path) };
}

/**
 * The whole document of a file, or one document of a YAML file holding several.
 *
 * @throws EditNotPossible when the file has no document at that index, or is not YAML.
 */
function documentAt(session: FileSession, index: number | undefined): EditableDocument {
    try {
        return session.document(index);
    } catch (error) {
        if (error instanceof NoSuchDocumentError) {
            throw new EditNotPossible(error.message);
        }

        throw error;
    }
}

/**
 * Adds `selectDocument(index)` to the chain's file handle: a handle on one document of a YAML file
 * holding several, whose every recorded operation carries `document: index`. `chain.ts` calls this
 * with its two handle classes.
 *
 * ```ts
 * const web = editor(config).file("deploy/web.yaml");
 *
 * web.selectDocument(1).at("spec.replicas").set(3);
 * // -> { file: "deploy/web.yaml", set: { path: "spec.replicas", value: 3, document: 1 } }
 * ```
 */
export function addSelectDocument(fileHandle: { prototype: object }, valueHandle: { prototype: object }): void {
    type Handle = { document?: number; record(operation: string, args: readonly unknown[]): unknown; at(path: string): Handle };

    for (const prototype of [fileHandle.prototype, valueHandle.prototype] as unknown as Handle[]) {
        const record = prototype.record;

        Object.defineProperty(prototype, "record", {
            value(this: Handle, operation: string, args: readonly unknown[]) {
                return record.call(this, operation, this.document === undefined ? args : withDocument(operation, args, this.document));
            },
            writable: true,
            configurable: true,
        });
    }

    const file = fileHandle.prototype as unknown as Handle;
    const at = file.at;

    Object.defineProperty(file, "at", {
        value(this: Handle, path: string) {
            const handle = at.call(this, path);

            if (this.document !== undefined) handle.document = this.document;

            return handle;
        },
        writable: true,
        configurable: true,
    });

    Object.defineProperty(file, "selectDocument", {
        value(this: Handle, index: number) {
            if (!Number.isInteger(index) || index < 0) {
                throw new Error("selectDocument() takes the document's index, a whole number from 0.");
            }

            return Object.assign(Object.create(Object.getPrototypeOf(this) as object) as Handle, this, { document: index });
        },
        writable: true,
        configurable: true,
    });
}

/** A chain call's arguments with `document` added to its options object. */
function withDocument(operation: string, args: readonly unknown[], document: number): unknown[] {
    const names = ALIASES.get(operation)?.args ?? OPERATIONS.get(operation)?.args ?? [];
    const options = args[names.length];

    return [...names.map((_, index) => args[index]), { ...(options as object | undefined), document }];
}

// Helpers.

/** A comment operation needs the path of a key or list item: the root has no comment of its own. */
function commentPath(raw: JsonObject, name: string): void {
    if (typeof raw.path !== "string" || raw.path === "") {
        throw new OperationParamsError(`'${name}' needs the 'path' of a key or list item; the root has no comment of its own.`);
    }
}

/**
 * The comments of the document the operation acts on.
 *
 * @throws EditNotPossible for a plain text file, which has no keys.
 */
function commentsOf(ctx: OperationContext, params: JsonObject, name: string): DocumentComments {
    const comments = documentAt(ctx.session, params.document as number | undefined).comments;

    if (comments === undefined) {
        throw new EditNotPossible(`'${name}' needs a JSONC, YAML or Markdown file; ${ctx.session.file} is plain text, which has no keys.`);
    }

    return comments;
}

/** Runs a comment edit, turning the library's refusal (plain JSON, a shared line) into a skipped edit. */
function onComment<T>(name: string, act: () => T): T {
    try {
        return act();
    } catch (error) {
        if (error instanceof CommentError) {
            throw new EditNotPossible(`'${name}': ${error.message}`);
        }

        throw error;
    }
}

/** Whether a comment already reads `text` (trailing spaces aside, which a file does not keep). */
function sameWords(current: string | undefined, text: string): boolean {
    const words = (value: string) => value.split(/\r?\n/).map((line) => line.trimEnd()).join("\n");

    return current !== undefined && words(current) === words(text);
}

/** The record of the first run that changed something is kept, so `down` restores what was there before Sous. */
function keepEarlier(previous: JsonValue, next: JsonValue): JsonValue {
    return isJsonObject(previous) && previous.changed === true ? previous : next;
}
