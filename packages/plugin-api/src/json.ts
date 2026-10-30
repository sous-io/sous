/**
 * Plain JSON values, and the patches that change them.
 *
 * The config is always plain JSON, and every change to it, or to any
 * document a plugin edits, is a list of primitive patches.
 */

/** A plain JSON value. */
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

/** A JSON scalar. */
export type JsonPrimitive = string | number | boolean | null;

/** A JSON array. */
export type JsonArray = JsonValue[];

/** A JSON object. */
export interface JsonObject {
    [key: string]: JsonValue;
}

/** One step of a path: an object key, or an array index. */
export type PathSegment = string | number;

/**
 * A path, as segments (`["subscriptions", "workflow/x", "enabled"]`) or as a string
 * (`subscriptions."workflow/x".enabled`, `compilation.targets[7].id`). `""` and `[]` name the root.
 */
export type PathInput = string | readonly PathSegment[];

/** Sets one key of an object, creating missing objects along the path. */
export interface SetKeyPatch {
    op: "setKey";
    /** The object holding the key, as a canonical path string. */
    path: string;
    key: string;
    value: JsonValue;
}

/** Deletes one key of an object. Deleting a missing key does nothing. */
export interface DeleteKeyPatch {
    op: "deleteKey";
    path: string;
    key: string;
}

/** Renames one key of an object, keeping its place. An existing key named `to` is replaced. */
export interface RenameKeyPatch {
    op: "renameKey";
    path: string;
    key: string;
    to: string;
}

/** Sets one item of an array. */
export interface SetIndexPatch {
    op: "setIndex";
    path: string;
    index: number;
    value: JsonValue;
}

/**
 * Inserts one item into an array, creating the array when it is missing. `"end"` appends, so an
 * append never depends on the array's length when the patch was made.
 */
export interface InsertAtPatch {
    op: "insertAt";
    path: string;
    index: number | "end";
    value: JsonValue;
}

/** Removes one item from an array. */
export interface RemoveIndexPatch {
    op: "removeIndex";
    path: string;
    index: number;
}

/** One primitive operation. Every other operation is a helper built on these. */
export type Patch =
    | SetKeyPatch
    | DeleteKeyPatch
    | RenameKeyPatch
    | SetIndexPatch
    | InsertAtPatch
    | RemoveIndexPatch;

/** The name of a primitive operation. */
export type PatchOp = Patch["op"];

/**
 * A named group of patches and other patch sets. A helper's work is one patch set
 * (`removeWhere compilation.targets`), and one contributor run produces one patch set.
 */
export interface PatchSet {
    /** What made it: a helper name (`removeWhere`) or a contributor id (`confd/610-mac.jsonc`). */
    name: string;
    /** The path the helper worked on, when it worked on one. */
    path?: string;
    patches: Array<Patch | PatchSet>;
}

/** The kind of a JSON value. */
export type ValueType = "object" | "array" | "string" | "number" | "boolean" | "null";
