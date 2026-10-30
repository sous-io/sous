/**
 * The public types of the document-editing package.
 *
 * Every change to a document, in memory or on disk, is expressed as primitive
 * {@link Patch}es, grouped into named {@link PatchSet}s. Primitives are plain
 * JSON, so any set of changes serializes to JSON and back.
 *
 * The JSON, path and patch types are owned by `@sous-io/plugin-api` (plugins see them there);
 * this package re-exports them and adds the types only document editing needs.
 */
import type { Patch, PathSegment, JsonValue } from "@sous-io/plugin-api";

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
} from "@sous-io/plugin-api";

/** A patch that could not be applied, and why. Applying carries on without it. */
export interface PatchProblem {
    patch: Patch;
    /** A plain sentence: `compilation.targets has 3 items, so there is no item 7 to remove.` */
    message: string;
}

/** Options for {@link applyPatches}. */
export interface ApplyOptions {
    /** Called after each primitive is applied. */
    onApplied?: (patch: Patch) => void;
    /** Called for each primitive that could not be applied. The default ignores it. */
    onProblem?: (problem: PatchProblem) => void;
}

/** The formats a text document can be in. */
export type DocumentFormat = "json" | "jsonc" | "yaml";

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
}
