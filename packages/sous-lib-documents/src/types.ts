/**
 * The public types of the document-editing package.
 *
 * Every change to a document, in memory or on disk, is expressed as primitive
 * {@link Patch}es, grouped into named {@link PatchSet}s. Primitives are plain
 * JSON, so any set of changes serializes to JSON and back.
 *
 * The JSON, path and patch types are owned by `@sous-io/sous-plugin-api` (plugins see them there);
 * this package re-exports them and adds the types only document editing needs.
 */
import type { Patch, PathSegment, JsonValue } from "@sous-io/sous-plugin-api";

export type {
    JsonValue,
    JsonPrimitive,
    JsonArray,
    JsonObject,
    PathSegment,
    PathInput,
    SetKeyPatch,
    DeleteKeyPatch,
    RenameKeyPatch,
    SetIndexPatch,
    InsertAtPatch,
    RemoveIndexPatch,
    Patch,
    PatchOp,
    PatchSet,
    ValueType,
    DocumentNode,
} from "@sous-io/sous-plugin-api";

/** A patch that could not be applied, and why. Applying carries on without it. */
export interface PatchProblem {
    patch: Patch;
    /** A plain sentence: `compilation.targets has 3 items, so there is no item 7 to remove.` */
    message: string;
}

/**
 * A key or list item exactly as it is written, and where it is, so that it can be put back in
 * the same place with the same bytes after it is removed (`DocNode.entrySource`,
 * `DocNode.restoreEntrySource`). Plain JSON, so it can be kept in a history.
 *
 * ```ts
 * // a: 1
 * // # about b
 * // b: 2
 * doc.atPath("b").entrySource();   // { source: "# about b\nb: 2\n", index: 1, after: "a" }
 * ```
 */
export interface EntrySource {
    /**
     * Its text: when it has lines of its own, its comment lines above, its own lines and the
     * comment ending its last line, line endings included; when it shares a line, its text alone.
     */
    source: string;
    /** Its index among the object's keys or the list's items. */
    index: number;
    /** The key just before it, for a key that is not the first. */
    after?: string;
    /**
     * How many lines (blank lines, or comments that belong to no key) lie between it and the
     * entry before it (for the first, the entry after it). Omitted when there are none.
     */
    gap?: number;
}

/** Where {@link DocNode.insertKey} puts a key: just before or after another key, or at an index. */
export type KeyPosition = { before: string } | { after: string } | { index: number };

/**
 * Where an entry goes among a container's entries: at `index`, placed right after the entry
 * before it (`previous`) or right before the entry at `index` with its comment lines (`next`),
 * then moved `lines` lines further (down from the previous entry, up from the next one) over lines
 * that hold only blanks or comments. Used by the text documents; a value document ignores all
 * but `index`.
 */
export interface Placement {
    index: number;
    from: "previous" | "next";
    lines: number;
}

/** Options for {@link applyPatches}. */
export interface ApplyOptions {
    /** Called after each primitive is applied. */
    onApplied?: (patch: Patch) => void;
    /** Called for each primitive that could not be applied. The default ignores it. */
    onProblem?: (problem: PatchProblem) => void;
}

/**
 * The formats a text document can be in. `markdown` is the YAML frontmatter of a Markdown file:
 * the document is the frontmatter, and the body is kept as it is.
 */
export type DocumentFormat = "json" | "jsonc" | "yaml" | "markdown";

/**
 * What a `DocNode` reads from and writes to. The in-memory document, the text documents and
 * the config builder each supply one; the builder's records every read.
 */
export interface DocumentBackend {
    /** The current value at a path (`undefined` when missing), including this session's changes. */
    read(path: readonly PathSegment[]): JsonValue | undefined;
    /** Applies one primitive and records it in the current patch set. */
    emit(patch: Patch): void;
    /** Opens a named patch set; primitives emitted until {@link closeSet} go into it. */
    openSet(name: string, path?: string): void;
    /** Closes the patch set opened last. */
    closeSet(): void;
    /**
     * Puts the entries (keys or items) of the object or list at `path` in a new order, each with
     * its own text: `order[i]` is the old index of the entry that ends up at `i`. `patches` are
     * the primitives that make the same change, recorded in the current patch set. Returns
     * `false` when it cannot, and the caller applies `patches` instead.
     */
    reorder?(path: readonly PathSegment[], order: readonly number[], patches: readonly Patch[]): boolean;
    /**
     * Adds a key (`key`) or an item (`key` undefined) to the object or list at `path`, at a
     * placement, written from `source` (an {@link EntrySource}'s text) when one is given and it
     * reads as the value. `patches` make the same change, as for {@link reorder}. Returns `false`
     * when it cannot.
     */
    place?(path: readonly PathSegment[], key: string | undefined, value: JsonValue, placement: Placement, source: string | undefined, patches: readonly Patch[]): boolean;
    /** A key or item as written, and where; `undefined` for a document with no text. */
    entrySource?(path: readonly PathSegment[]): EntrySource | undefined;
    /** A value as written; `undefined` for a document with no text. */
    valueSource?(path: readonly PathSegment[]): string | undefined;
    /**
     * Applies a `setKey` or `setIndex` replacing an existing value, writing `source` (a value's
     * text) when it reads as the value, and records it. Returns `false` when it cannot.
     */
    setFromSource?(patch: Patch, source: string): boolean;
}
