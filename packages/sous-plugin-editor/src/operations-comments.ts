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
 * Every function here is a function declaration: `operations.ts` calls them while it loads, which
 * may be before this module's own body has run.
 */

import { CommentError, isJsonObject, type CommentPlace, type JsonObject, type JsonValue } from "@sous-io/sous-lib-documents";
import type { DocumentComments } from "./documents-adapter.js";
import { EditNotPossible, OperationParamsError, type OperationContext, type OperationDefinition } from "./operations.js";

/** An operation as `define` in `operations.ts` takes it. */
export type OperationDraft = Omit<OperationDefinition, "normalize"> & { normalize?: (raw: JsonObject) => JsonObject };


/** The comment operations, for `operations.ts` to define. */
export function commentOperations(): OperationDraft[] {
    return [setCommentOperation("before"), setCommentOperation("after")];
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
function commentsOf(ctx: OperationContext, _params: JsonObject, name: string): DocumentComments {
    const comments = ctx.session.document().comments;

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
