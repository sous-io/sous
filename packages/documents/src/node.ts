/**
 * The node API (S2, "The Document-Editing Package"): one place in a document, with the inspecting
 * methods, the primitives and the helpers built on them. A node holds no state; it reads from and
 * writes to its document's backend.
 */
import { formatPath, parsePath } from "./path.js";
import { isJsonObject, stableStringify, toPlainJson, typeOfValue } from "./json.js";
import type { DocumentBackend, DocumentNode, JsonObject, JsonValue, Patch, PathInput, PathSegment, ValueType } from "./types.js";

/** A predicate over array items. Items are plain JSON; `any` lets `(target) => target.id === "x"` compile. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ItemPredicate = (item: any, index: number) => boolean;

/**
 * One place in a document.
 *
 * ```ts
 * const targets = doc.atPath("compilation.targets");
 *
 * targets.removeWhere((target) => target.id === "diagrams");
 * targets.append({ id: "diagrams", entryGlob: "docs/**\/*.mmd" });
 * ```
 */
export class DocNode implements DocumentNode {
    /** The path of this node, as segments. */
    readonly path: readonly PathSegment[];

    constructor(private readonly backend: DocumentBackend, path: readonly PathSegment[]) {
        this.path = Object.freeze([...path]);
    }

    /** The path of this node, as a canonical string (`compilation.targets[7]`). */
    get pathString(): string {
        return formatPath(this.path);
    }

    /** A node below this one. */
    atPath(path: PathInput): DocNode {
        return new DocNode(this.backend, [...this.path, ...parsePath(path)]);
    }

    /** The item at an index of this array node. */
    atIndex(index: number): DocNode {
        return new DocNode(this.backend, [...this.path, ...parsePath([index])]);
    }

    /** The node holding this one; the root's parent is the root. */
    parent(): DocNode {
        return new DocNode(this.backend, this.path.slice(0, -1));
    }

    // Inspecting: each reads.

    /** Whether a value exists here. */
    exists(): boolean {
        return this.read() !== undefined;
    }

    /** The kind of value here, or `"missing"`. */
    type(): ValueType | "missing" {
        return typeOfValue(this.read());
    }

    /** Whether the value here is an array. */
    isArray(): boolean {
        return Array.isArray(this.read());
    }

    /** Whether the value here is an object. */
    isObject(): boolean {
        return isJsonObject(this.read());
    }

    /** The value here, or `undefined` when missing. */
    get<T = JsonValue>(): T | undefined {
        return this.read() as T | undefined;
    }

    /** The value here, or the fallback when missing. */
    valueOr<T>(fallback: T): T {
        const value = this.read();

        return value === undefined ? fallback : (value as T);
    }

    /** The keys of this object node; `[]` for anything else. */
    keys(): string[] {
        const value = this.read();

        return isJsonObject(value) ? Object.keys(value) : [];
    }

    /** The number of items of this array node; `0` for anything else. */
    length(): number {
        const value = this.read();

        return Array.isArray(value) ? value.length : 0;
    }

    // Objects and values.

    /** Sets the value here. `undefined` deletes it. Never reads, except at the root. */
    set(value: unknown): void {
        const plain = toPlainJson(value);

        if (plain === undefined) {
            this.delete();
        } else if (this.path.length === 0) {
            this.replace(plain);
        } else {
            this.backend.emit(this.setPatch(plain));
        }
    }

    /** The same as {@link set}, under the name the S2 examples use. */
    setValue(value: unknown): void {
        this.set(value);
    }

    /** Deletes the value here. Never reads, except at the root, where it empties the document. */
    delete(): void {
        if (this.path.length === 0) {
            this.replace(Array.isArray(this.read()) ? [] : {});

            return;
        }

        const { parent, last } = this.split();

        this.backend.emit(typeof last === "number"
            ? { op: "removeIndex", path: parent, index: last }
            : { op: "deleteKey", path: parent, key: last });
    }

    /** Renames this node's key, keeping its place. Never reads. */
    rename(newKey: string): void {
        const { parent, last } = this.split();

        if (typeof last === "number") {
            throw new Error(`${this.pathString} is an array item, so it has no key to rename.`);
        }

        this.backend.emit({ op: "renameKey", path: parent, key: last, to: newKey });
    }

    /**
     * Merges data key by key: objects merge into objects, arrays are joined by appending each
     * item, and anything else replaces what is there. Reads every key it touches.
     */
    merge(data: unknown): void {
        const plain = toPlainJson(data);

        if (plain === undefined) {
            return;
        }

        this.group("merge", () => {
            const current = this.read();

            if (isJsonObject(plain) && (current === undefined || isJsonObject(current))) {
                this.mergeObject(this.path, plain, current);
            } else {
                this.set(plain);
            }
        });
    }

    /** Replaces the value here whole. At the root, removes what the new value lacks and sets the rest. */
    replace(value: unknown): void {
        const plain = toPlainJson(value);

        this.group("replace", () => {
            if (this.path.length > 0) {
                if (plain === undefined) {
                    this.delete();
                } else {
                    this.backend.emit(this.setPatch(plain));
                }

                return;
            }

            this.replaceRoot(plain === undefined ? {} : plain);
        });
    }

    // Arrays.

    /** Appends an item, creating the array when missing. Never reads. */
    append(item: unknown): void {
        this.insert("end", item);
    }

    /** The same as {@link append}, under the name the S2 examples use. */
    appendValue(item: unknown): void {
        this.append(item);
    }

    /** Inserts an item first. Never reads. */
    prepend(item: unknown): void {
        this.insert(0, item);
    }

    /** The same as {@link prepend}. */
    prependValue(item: unknown): void {
        this.prepend(item);
    }

    /** Inserts an item at an index. Never reads. */
    insertAt(index: number, item: unknown): void {
        this.insert(index, item);
    }

    /** Removes the item at an index. Never reads. */
    removeAt(index: number): void {
        this.backend.emit({ op: "removeIndex", path: this.pathString, index });
    }

    /** Removes every matching item, one `removeIndex` per match, highest index first. */
    removeWhere(predicate: ItemPredicate): void {
        this.group("removeWhere", () => {
            const items = this.items();

            for (let i = items.length - 1; i >= 0; i--) {
                if (predicate(items[i], i)) {
                    this.removeAt(i);
                }
            }
        });
    }

    /** Replaces the first matching item, or appends the item when nothing matches. */
    upsertWhere(predicate: ItemPredicate, item: unknown): void {
        this.group("upsertWhere", () => {
            const index = this.items().findIndex((value, i) => predicate(value, i));
            const plain = toPlainJson(item);

            if (plain === undefined) {
                if (index !== -1) {
                    this.removeAt(index);
                }
            } else if (index === -1) {
                this.append(plain);
            } else {
                this.backend.emit({ op: "setIndex", path: this.pathString, index, value: plain });
            }
        });
    }

    /** A node for the first matching item, to edit in place, or `undefined`. */
    findWhere(predicate: ItemPredicate): DocNode | undefined {
        const index = this.items().findIndex((value, i) => predicate(value, i));

        return index === -1 ? undefined : this.atIndex(index);
    }

    /** Moves an item from one index to another (the index it ends up at). */
    move(from: number, to: number): void {
        this.group("move", () => {
            const items = this.items();

            if (from < 0 || from >= items.length || from === to) {
                return;
            }

            this.removeAt(from);
            this.backend.emit({ op: "insertAt", path: this.pathString, index: to, value: items[from]! });
        });
    }

    /** Removes repeated items, keeping the first of each; `by` picks what makes two items the same. */
    dedupe(by?: (item: JsonValue) => unknown): void {
        this.group("dedupe", () => {
            const items = this.items();
            const seen = new Set<string>();
            const repeats: number[] = [];

            items.forEach((item, index) => {
                const fingerprint = stableStringify(by === undefined ? item : by(item));

                if (seen.has(fingerprint)) {
                    repeats.push(index);
                } else {
                    seen.add(fingerprint);
                }
            });

            for (const index of repeats.reverse()) {
                this.removeAt(index);
            }
        });
    }

    /**
     * Runs a helper of your own: the primitives it makes are grouped in a patch set with this name
     * and this node's path (C75).
     *
     * ```ts
     * node.patchSet("appendUnique", (n) => {
     *     if (!n.valueOr<string[]>([]).includes("x")) n.append("x");
     * });
     * ```
     */
    patchSet(name: string, helper: (node: DocNode) => void): void {
        this.group(name, () => helper(this));
    }

    // Internals.

    private read(): JsonValue | undefined {
        return this.backend.read(this.path);
    }

    private items(): JsonValue[] {
        const value = this.read();

        return Array.isArray(value) ? value : [];
    }

    private group(name: string, body: () => void): void {
        this.backend.openSet(name, this.pathString);

        try {
            body();
        } finally {
            this.backend.closeSet();
        }
    }

    private insert(index: number | "end", item: unknown): void {
        const value = toPlainJson(item);

        if (value !== undefined) {
            this.backend.emit({ op: "insertAt", path: this.pathString, index, value });
        }
    }

    private split(): { parent: string; last: PathSegment } {
        return { parent: formatPath(this.path.slice(0, -1)), last: this.path[this.path.length - 1]! };
    }

    private setPatch(value: JsonValue): Patch {
        const { parent, last } = this.split();

        return typeof last === "number"
            ? { op: "setIndex", path: parent, index: last, value }
            : { op: "setKey", path: parent, key: last, value };
    }

    private mergeObject(path: readonly PathSegment[], data: JsonObject, current: JsonObject | undefined): void {
        const where = formatPath(path);

        for (const [key, value] of Object.entries(data)) {
            const existing = current !== undefined && Object.hasOwn(current, key) ? current[key] : undefined;
            const childPath = [...path, key];

            if (isJsonObject(value) && (existing === undefined || isJsonObject(existing))) {
                if (Object.keys(value).length === 0) {
                    if (existing === undefined) {
                        this.backend.emit({ op: "setKey", path: where, key, value: {} });
                    }
                } else {
                    this.mergeObject(childPath, value, existing);
                }
            } else if (Array.isArray(value) && (existing === undefined || Array.isArray(existing))) {
                if (value.length === 0 && existing === undefined) {
                    this.backend.emit({ op: "setKey", path: where, key, value: [] });
                }

                const arrayPath = formatPath(childPath);

                for (const item of value) {
                    this.backend.emit({ op: "insertAt", path: arrayPath, index: "end", value: item });
                }
            } else {
                this.backend.emit({ op: "setKey", path: where, key, value });
            }
        }
    }

    private replaceRoot(value: JsonValue): void {
        const current = this.read();

        if (isJsonObject(value)) {
            if (Array.isArray(current)) {
                throw new Error("The root is an array, so it cannot be replaced by an object.");
            }

            for (const key of Object.keys(current ?? {})) {
                if (!Object.hasOwn(value, key)) {
                    this.backend.emit({ op: "deleteKey", path: "", key });
                }
            }

            for (const [key, item] of Object.entries(value)) {
                this.backend.emit({ op: "setKey", path: "", key, value: item });
            }

            return;
        }

        if (Array.isArray(value) && (current === undefined || Array.isArray(current))) {
            for (let i = (current?.length ?? 0) - 1; i >= 0; i--) {
                this.backend.emit({ op: "removeIndex", path: "", index: i });
            }

            for (const item of value) {
                this.backend.emit({ op: "insertAt", path: "", index: "end", value: item });
            }

            return;
        }

        if (Array.isArray(value)) {
            throw new Error("The root is an object, so it cannot be replaced by an array.");
        }

        throw new Error(`The root can only be replaced by an object or an array; got ${typeOfValue(value)}.`);
    }
}
