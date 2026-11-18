/**
 * Applying primitive patches to plain JSON values, copy on write: inputs are never changed (they
 * may be frozen), and only the containers along each changed path are copied.
 */
import { formatPath, parsePath } from "./path.js";
import { child, isJsonObject, setOwn, typeOfValue } from "./json.js";
import type { ApplyOptions, JsonObject, JsonValue, Patch, PathSegment } from "./types.js";

type Container = JsonObject | JsonValue[];

/**
 * Applies one primitive. See {@link applyPatches}.
 *
 * ```ts
 * applyPatch({}, { op: "setKey", path: "compilation", key: "overwriteUntracked", value: false });
 * // { compilation: { overwriteUntracked: false } }
 * ```
 */
export function applyPatch(root: JsonValue | undefined, patch: Patch, options?: ApplyOptions): JsonValue | undefined {
    return applyPatches(root, [patch], options);
}

/**
 * Applies primitives in order and returns the new root. The input is never changed. Missing
 * objects along a path are created, and `insertAt` creates a missing array. A patch that cannot
 * apply (a type conflict, an index out of range, renaming a missing key) is passed to
 * `onProblem` and skipped; deleting a missing key does nothing.
 *
 * ```ts
 * applyPatches(undefined, [
 *     { op: "insertAt", path: "targets", index: "end", value: "a" },
 *     { op: "insertAt", path: "targets", index: 0, value: "b" },
 * ]);
 * // { targets: ["b", "a"] }
 * ```
 */
export function applyPatches(
    root: JsonValue | undefined,
    patches: Iterable<Patch>,
    options: ApplyOptions = {},
): JsonValue | undefined {
    const session = new ApplySession(options);
    let current = root;

    for (const patch of patches) {
        current = session.apply(current, patch);
    }

    return current;
}

/** One run of {@link applyPatches}: remembers which containers it made, so it edits them in place. */
class ApplySession {
    private readonly owned = new WeakSet<object>();

    constructor(private readonly options: ApplyOptions) {}

    apply(root: JsonValue | undefined, patch: Patch): JsonValue | undefined {
        const segments = parsePath(patch.path);
        const problem = this.check(root, segments, patch);

        if (problem === "noop") {
            return root;
        }

        if (problem !== undefined) {
            this.options.onProblem?.({ patch, message: problem });

            return root;
        }

        const result = this.change(root, segments, patch);

        this.options.onApplied?.(patch);

        return result;
    }

    /** Finds why a patch cannot apply, `"noop"` when it changes nothing, or `undefined`. */
    private check(root: JsonValue | undefined, segments: PathSegment[], patch: Patch): string | "noop" | undefined {
        let current = root;

        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i]!;

            if (current === undefined) {
                if (patch.op === "deleteKey") {
                    return "noop";
                }

                if (patch.op !== "setKey" && patch.op !== "insertAt") {
                    return `${describeAt(segments)} is missing.`;
                }

                const index = segments.slice(i).findIndex((rest) => typeof rest === "number");

                if (index !== -1) {
                    const at = i + index;

                    return `${nameOf(formatPath(segments.slice(0, at)))} is missing, so it has no item ${segments[at]}.`;
                }

                if (patch.op === "insertAt" && patch.index !== "end" && patch.index !== 0) {
                    return `${describeAt(segments)} is missing, so an item cannot be inserted at ${patch.index}.`;
                }

                return undefined;
            }

            const where = formatPath(segments.slice(0, i));

            if (typeof segment === "number") {
                if (!Array.isArray(current)) {
                    return `${nameOf(where)} is ${article(current)}, not an array, so it has no item ${segment}.`;
                }

                if (segment >= current.length) {
                    if (patch.op === "deleteKey") {
                        return "noop";
                    }

                    return `${nameOf(where)} has ${items(current.length)}, so there is no item ${segment}.`;
                }
            } else if (!isJsonObject(current)) {
                return `${nameOf(where)} is ${article(current)}, not an object, so it has no key ${JSON.stringify(segment)}.`;
            }

            current = child(current, segment);
        }

        return checkTarget(current, segments, patch);
    }

    /** Applies a patch that {@link check} accepted. */
    private change(root: JsonValue | undefined, segments: PathSegment[], patch: Patch): JsonValue {
        const wantsArray = patch.op === "insertAt" || patch.op === "setIndex" || patch.op === "removeIndex";
        const top = this.writable(root, segments.length === 0 && wantsArray);
        let parent: Container = top;

        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i]!;
            const last = i === segments.length - 1;
            const next = this.writable(child(parent, segment), last && wantsArray);

            put(parent, segment, next);
            parent = next;
        }

        operate(parent, patch);

        return top;
    }

    /** A container that may be changed in place: this session's own, a fresh copy, or a new one. */
    private writable(value: JsonValue | undefined, array: boolean): Container {
        if (value === undefined) {
            return this.own(array ? [] : {});
        }

        const container = value as Container;

        if (this.owned.has(container)) {
            return container;
        }

        return this.own(Array.isArray(container) ? container.slice() : { ...container });
    }

    private own<T extends Container>(container: T): T {
        this.owned.add(container);

        return container;
    }
}

/** Checks the container a patch acts on. */
function checkTarget(target: JsonValue | undefined, segments: PathSegment[], patch: Patch): string | "noop" | undefined {
    const where = nameOf(formatPath(segments));

    switch (patch.op) {
        case "setKey":
            if (target !== undefined && !isJsonObject(target)) {
                return `${where} is ${article(target)}, not an object, so setKey cannot set ${JSON.stringify(patch.key)} on it.`;
            }

            return undefined;
        case "deleteKey":
            return isJsonObject(target) && Object.hasOwn(target, patch.key) ? undefined : "noop";
        case "renameKey":
            if (!isJsonObject(target) || !Object.hasOwn(target, patch.key)) {
                return `${where} has no key ${JSON.stringify(patch.key)} to rename.`;
            }

            return patch.key === patch.to ? "noop" : undefined;
        case "insertAt":
            if (target === undefined) {
                return patch.index === "end" || patch.index === 0
                    ? undefined
                    : `${where} is missing, so an item cannot be inserted at ${patch.index}.`;
            }

            if (!Array.isArray(target)) {
                return `${where} is ${article(target)}, not an array, so insertAt cannot insert into it.`;
            }

            if (patch.index !== "end" && !validIndex(patch.index, target.length)) {
                return `${where} has ${items(target.length)}, so an item cannot be inserted at ${patch.index}.`;
            }

            return undefined;
        case "setIndex":
        case "removeIndex": {
            const verb = patch.op === "setIndex" ? "set" : "remove";

            if (!Array.isArray(target)) {
                return target === undefined
                    ? `${where} is missing, so there is no item ${patch.index} to ${verb}.`
                    : `${where} is ${article(target)}, not an array, so there is no item ${patch.index} to ${verb}.`;
            }

            if (!validIndex(patch.index, target.length - 1)) {
                return `${where} has ${items(target.length)}, so there is no item ${patch.index} to ${verb}.`;
            }

            return undefined;
        }
    }
}

/** Performs a checked patch on its (writable) container. */
function operate(container: Container, patch: Patch): void {
    switch (patch.op) {
        case "setKey":
            setOwn(container as JsonObject, patch.key, patch.value);
            break;
        case "deleteKey":
            delete (container as JsonObject)[patch.key];
            break;
        case "renameKey":
            renameInPlace(container as JsonObject, patch.key, patch.to);
            break;
        case "setIndex":
            (container as JsonValue[])[patch.index] = patch.value;
            break;
        case "insertAt": {
            const array = container as JsonValue[];

            array.splice(patch.index === "end" ? array.length : patch.index, 0, patch.value);
            break;
        }
        case "removeIndex":
            (container as JsonValue[]).splice(patch.index, 1);
            break;
    }
}

/** Renames a key keeping its place; an existing key named `to` is replaced. */
function renameInPlace(object: JsonObject, from: string, to: string): void {
    const entries = Object.entries(object);

    for (const key of Object.keys(object)) {
        delete object[key];
    }

    for (const [key, value] of entries) {
        if (key === to) {
            continue;
        }

        setOwn(object, key === from ? to : key, value);
    }
}

function put(container: Container, segment: PathSegment, value: JsonValue): void {
    if (typeof segment === "number") {
        (container as JsonValue[])[segment] = value;
    } else {
        setOwn(container as JsonObject, segment, value);
    }
}

function validIndex(index: number, max: number): boolean {
    return Number.isInteger(index) && index >= 0 && index <= max;
}

function nameOf(path: string): string {
    return path === "" ? "The root" : path;
}

function describeAt(segments: PathSegment[]): string {
    return nameOf(formatPath(segments));
}

function items(count: number): string {
    return count === 1 ? "1 item" : `${count} items`;
}

function article(value: JsonValue): string {
    const type = typeOfValue(value);

    return type === "array" || type === "object" ? `an ${type}` : type === "null" ? "null" : `a ${type}`;
}
