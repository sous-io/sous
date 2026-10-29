import type { JsonValue, PathInput, PathSegment, ValueType } from "./json.js";

/**
 * One place in a document, or in the config while it is built: the operations S2 lists in "The
 * Document-Editing Package". Inspecting methods read the value (the config builder records each
 * read); every change becomes primitive patches.
 *
 * ```ts
 * const targets = config.atPath("compilation.targets");
 *
 * if (targets.isArray()) {
 *     targets.removeWhere((target) => target.id === "diagrams");
 * }
 *
 * targets.append({ id: "diagrams", entryGlob: "docs/**\/*.mmd" });
 * ```
 */
export interface DocumentNode {
    /** The path of this node, as segments. */
    readonly path: readonly PathSegment[];
    /** The path of this node, as a canonical string (`compilation.targets[7]`). */
    readonly pathString: string;

    /** A node below this one. */
    atPath(path: PathInput): DocumentNode;
    /** The item at an index of this array node. */
    atIndex(index: number): DocumentNode;
    /** The node holding this one; the root's parent is the root. */
    parent(): DocumentNode;

    // Inspecting (each reads)

    /** Whether a value exists here. */
    exists(): boolean;
    /** The kind of value here, or `"missing"`. */
    type(): ValueType | "missing";
    isArray(): boolean;
    isObject(): boolean;
    /** The value here, or `undefined` when missing. */
    get<T = JsonValue>(): T | undefined;
    /** The value here, or the fallback when missing. */
    valueOr<T>(fallback: T): T;
    /** The keys of this object node; `[]` for anything else. */
    keys(): string[];
    /** The number of items of this array node; `0` for anything else. */
    length(): number;

    // Objects and values

    /** Sets the value here. `undefined` deletes it. Never reads. */
    set(value: unknown): void;
    /** The same as {@link set}, under the name the S2 examples use. */
    setValue(value: unknown): void;
    /** Deletes the value here. Never reads. */
    delete(): void;
    /** Renames this node's key, keeping its place. Never reads. */
    rename(newKey: string): void;
    /** Merges an object key by key, joining arrays. Reads every key it touches. */
    merge(data: unknown): void;
    /** Replaces the value here whole. */
    replace(value: unknown): void;

    // Arrays

    /** Appends an item, creating the array when missing. Never reads. */
    append(item: unknown): void;
    /** The same as {@link append}, under the name the S2 examples use. */
    appendValue(item: unknown): void;
    /** Inserts an item first. Never reads. */
    prepend(item: unknown): void;
    /** The same as {@link prepend}. */
    prependValue(item: unknown): void;
    /** Inserts an item at an index. Never reads. */
    insertAt(index: number, item: unknown): void;
    /** Removes the item at an index. Never reads. */
    removeAt(index: number): void;
    /** Removes every matching item, highest index first. */
    removeWhere(predicate: (item: any, index: number) => boolean): void;
    /** Replaces the first matching item, or appends the item when nothing matches. */
    upsertWhere(predicate: (item: any, index: number) => boolean, item: unknown): void;
    /** A node for the first matching item, to edit in place. */
    findWhere(predicate: (item: any, index: number) => boolean): DocumentNode | undefined;
    /** Moves an item from one index to another. */
    move(from: number, to: number): void;
    /** Removes repeated items, keeping the first of each. */
    dedupe(by?: (item: any) => unknown): void;

    /**
     * Runs a helper of your own: the primitives it makes are grouped in a patch set with this name
     * and this node's path, so `--layers` shows them under it (C75).
     */
    patchSet(name: string, helper: (node: DocumentNode) => void): void;
}
