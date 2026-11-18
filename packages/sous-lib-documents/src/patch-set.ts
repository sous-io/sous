/**
 * Patch sets: telling patches and sets apart, flattening them, and recording them as they are made.
 */
import type { Patch, PatchOp, PatchSet } from "./types.js";

/** Every primitive operation. */
export const PATCH_OPS: readonly PatchOp[] = Object.freeze([
    "setKey",
    "deleteKey",
    "renameKey",
    "setIndex",
    "insertAt",
    "removeIndex",
]);

/**
 * Whether a value is a primitive patch (it has a known `op`).
 *
 * ```ts
 * isPatch({ op: "deleteKey", path: "tools", key: "codex" });   // true
 * ```
 */
export function isPatch(value: unknown): value is Patch {
    return typeof value === "object" && value !== null
        && PATCH_OPS.includes((value as { op?: unknown }).op as PatchOp);
}

/**
 * Whether a value is a patch set (a `name` and a `patches` array, and no `op`).
 *
 * ```ts
 * isPatchSet({ name: "merge", patches: [] });   // true
 * ```
 */
export function isPatchSet(value: unknown): value is PatchSet {
    return typeof value === "object" && value !== null && !("op" in value)
        && typeof (value as { name?: unknown }).name === "string"
        && Array.isArray((value as { patches?: unknown }).patches);
}

/**
 * Every primitive in a patch set, in order, however deeply nested.
 *
 * ```ts
 * flattenPatchSet({ name: "c", patches: [p1, { name: "merge", patches: [p2, p3] }] });
 * // [p1, p2, p3]
 * ```
 */
export function flattenPatchSet(set: PatchSet): Patch[] {
    const out: Patch[] = [];

    collect(set, out);

    return out;
}

function collect(set: PatchSet, out: Patch[]): void {
    for (const item of set.patches) {
        if (isPatchSet(item)) {
            collect(item, out);
        } else {
            out.push(item);
        }
    }
}

/**
 * How many primitives a patch set holds, however deeply nested.
 */
export function countPatches(set: PatchSet): number {
    let count = 0;

    for (const item of set.patches) {
        count += isPatchSet(item) ? countPatches(item) : 1;
    }

    return count;
}

/**
 * Builds one patch set as patches are made: helpers open a named set, add their primitives and
 * close it. A helper set that ends up empty is dropped.
 *
 * ```ts
 * const recorder = new PatchRecorder("diagrams");
 * recorder.open("removeWhere", "compilation.targets");
 * recorder.add({ op: "removeIndex", path: "compilation.targets", index: 7 });
 * recorder.close();
 * recorder.result();
 * // { name: "diagrams", patches: [{ name: "removeWhere", path: "compilation.targets", patches: [...] }] }
 * ```
 */
export class PatchRecorder {
    private readonly root: PatchSet;
    private readonly stack: PatchSet[];

    constructor(rootName: string) {
        this.root = { name: rootName, patches: [] };
        this.stack = [this.root];
    }

    /** Adds a primitive, or a whole patch set, to the set open now. */
    add(patch: Patch | PatchSet): void {
        this.stack[this.stack.length - 1]!.patches.push(patch);
    }

    /** Opens a named set inside the one open now. */
    open(name: string, path?: string): void {
        const set: PatchSet = path === undefined ? { name, patches: [] } : { name, path, patches: [] };

        this.stack.push(set);
    }

    /** Closes the set opened last, adding it to its parent unless it is empty. */
    close(): void {
        if (this.stack.length === 1) {
            throw new Error("PatchRecorder.close() was called with no patch set open.");
        }

        const set = this.stack.pop()!;

        if (set.patches.length > 0) {
            this.add(set);
        }
    }

    /** Whether nothing has been recorded. */
    isEmpty(): boolean {
        return this.root.patches.length === 0;
    }

    /** The patch set recorded so far. Sets still open are added when they close. */
    result(): PatchSet {
        return this.root;
    }
}
