/**
 * Plain JSON values: making them, comparing them, freezing them and reading inside them.
 */
import type { JsonObject, JsonValue, PathSegment, ValueType } from "./types.js";

/**
 * A fresh, plain JSON copy of any value, following the config's rules:
 * `undefined`, functions, symbols, bigints, `Date`s, `Map`s and `Set`s are dropped (an array item
 * too, not turned into `null`); a `RegExp` becomes the string `/source/flags`; `NaN` and the
 * infinities become `null`; `toJSON()` is honored. Returns `undefined` when the value itself is
 * dropped.
 *
 * ```ts
 * toPlainJson({ a: 1, b: undefined, re: /x+/g, items: [1, undefined, 2] });
 * // { a: 1, re: "/x+/g", items: [1, 2] }
 * ```
 */
export function toPlainJson(value: unknown): JsonValue | undefined {
    return plain(value, new Set());
}

function plain(value: unknown, seen: Set<object>): JsonValue | undefined {
    switch (typeof value) {
        case "string":
        case "boolean":
            return value;
        case "number":
            return Number.isFinite(value) ? value : null;
        case "object":
            break;
        default:
            return undefined;
    }

    if (value === null) {
        return null;
    }

    if (value instanceof RegExp) {
        return `/${value.source}/${value.flags}`;
    }

    if (value instanceof Date || value instanceof Map || value instanceof Set
        || value instanceof WeakMap || value instanceof WeakSet || value instanceof Promise) {
        return undefined;
    }

    if (seen.has(value)) {
        throw new TypeError("The value refers to itself, so it cannot be turned into JSON.");
    }

    const withToJson = value as { toJSON?: unknown };

    if (typeof withToJson.toJSON === "function") {
        return plain((withToJson.toJSON as () => unknown)(), seen);
    }

    seen.add(value);

    try {
        if (Array.isArray(value)) {
            const out: JsonValue[] = [];

            for (const item of value) {
                const converted = plain(item, seen);

                if (converted !== undefined) {
                    out.push(converted);
                }
            }

            return out;
        }

        const out: JsonObject = {};

        for (const key of Object.keys(value)) {
            const converted = plain((value as Record<string, unknown>)[key], seen);

            if (converted !== undefined) {
                setOwn(out, key, converted);
            }
        }

        return out;
    } finally {
        seen.delete(value);
    }
}

/**
 * Sets an own property, even one named `__proto__`, without touching the prototype.
 */
export function setOwn(target: JsonObject, key: string, value: JsonValue): void {
    if (key === "__proto__") {
        Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
    } else {
        target[key] = value;
    }
}

/**
 * Whether a value is a JSON object (not an array, not `null`).
 */
export function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The kind of a JSON value, or `"missing"` for `undefined`.
 *
 * ```ts
 * typeOfValue([1]);         // "array"
 * typeOfValue(undefined);   // "missing"
 * ```
 */
export function typeOfValue(value: JsonValue | undefined): ValueType | "missing" {
    if (value === undefined) {
        return "missing";
    }

    if (value === null) {
        return "null";
    }

    if (Array.isArray(value)) {
        return "array";
    }

    return typeof value as ValueType;
}

/**
 * Whether two JSON values are equal, item by item and key by key (key order does not matter).
 *
 * ```ts
 * deepEqual({ a: [1, 2] }, { a: [1, 2] });   // true
 * ```
 */
export function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) {
        return true;
    }

    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
        return false;
    }

    if (Array.isArray(a)) {
        if (!Array.isArray(b) || a.length !== b.length) {
            return false;
        }

        for (let i = 0; i < a.length; i++) {
            if (!deepEqual(a[i], b[i])) {
                return false;
            }
        }

        return true;
    }

    if (Array.isArray(b)) {
        return false;
    }

    const aKeys = Object.keys(a);

    if (aKeys.length !== Object.keys(b).length) {
        return false;
    }

    for (const key of aKeys) {
        if (!Object.hasOwn(b, key)) {
            return false;
        }

        if (!deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
            return false;
        }
    }

    return true;
}

/**
 * JSON text with every object's keys sorted, so equal values give equal text. `undefined` gives
 * `"undefined"`, so a missing value has a fingerprint too.
 *
 * ```ts
 * stableStringify({ b: 1, a: [true] });   // '{"a":[true],"b":1}'
 * ```
 */
export function stableStringify(value: unknown): string {
    if (value === undefined) {
        return "undefined";
    }

    if (typeof value !== "object" || value === null) {
        return JSON.stringify(value) ?? "undefined";
    }

    if (Array.isArray(value)) {
        return `[${value.map((item) => (item === undefined ? "null" : stableStringify(item))).join(",")}]`;
    }

    const parts: string[] = [];

    for (const key of Object.keys(value).sort()) {
        const item = (value as Record<string, unknown>)[key];

        if (item !== undefined) {
            parts.push(`${JSON.stringify(key)}:${stableStringify(item)}`);
        }
    }

    return `{${parts.join(",")}}`;
}

/**
 * Freezes a value and everything inside it. A value that is already frozen is taken to be frozen
 * all the way down, and skipped.
 *
 * ```ts
 * const config = deepFreeze({ a: { b: 1 } });
 * Object.isFrozen(config.a);   // true
 * ```
 */
export function deepFreeze<T>(value: T): T {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
        return value;
    }

    Object.freeze(value);

    for (const key of Object.keys(value)) {
        deepFreeze((value as Record<string, unknown>)[key]);
    }

    return value;
}

/**
 * The value at a path, or `undefined` when anything along it is missing. Number segments read
 * arrays and string segments read objects; a mismatch is missing.
 *
 * ```ts
 * getAtPath({ targets: [{ id: "a" }] }, ["targets", 0, "id"]);   // "a"
 * ```
 */
export function getAtPath(root: JsonValue | undefined, segments: readonly PathSegment[]): JsonValue | undefined {
    let current: JsonValue | undefined = root;

    for (const segment of segments) {
        current = child(current, segment);

        if (current === undefined) {
            return undefined;
        }
    }

    return current;
}

/**
 * One step down: the item of an array or the own key of an object.
 */
export function child(container: JsonValue | undefined, segment: PathSegment): JsonValue | undefined {
    if (typeof segment === "number") {
        return Array.isArray(container) ? container[segment] : undefined;
    }

    if (isJsonObject(container) && Object.hasOwn(container, segment)) {
        return container[segment];
    }

    return undefined;
}
