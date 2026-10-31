import { describe, expect, it } from "vitest";
import { child, deepEqual, deepFreeze, getAtPath, isJsonObject, setOwn, stableStringify, toPlainJson, typeOfValue } from "./json.js";

describe("toPlainJson()", () => {
    /**
     * toPlainJson should drop what JSON cannot hold, including array items, rather than writing null.
     *
     * toPlainJson({ a: 1, b: undefined, items: [1, undefined, () => 0, 2] });
     * // -> { a: 1, items: [1, 2] }
     */
    it("should drop undefined, functions, symbols and bigints, even inside arrays", () => {
        expect(toPlainJson({ a: 1, b: undefined, f: () => 0, s: Symbol("x"), n: 10n, items: [1, undefined, () => 0, 2] }))
            .toEqual({ a: 1, items: [1, 2] });
        expect(toPlainJson(undefined)).toBeUndefined();
        expect(toPlainJson(() => 0)).toBeUndefined();
    });

    /**
     * toPlainJson should drop Dates, Maps and Sets, and write a RegExp as "/source/flags".
     *
     * toPlainJson({ at: new Date(), re: /x+/g });   // -> { re: "/x+/g" }
     */
    it("should drop Dates, Maps and Sets and write regular expressions as strings", () => {
        expect(toPlainJson({ at: new Date(), m: new Map(), s: new Set([1]), w: new WeakMap(), p: Promise.resolve(), re: /x+/g }))
            .toEqual({ re: "/x+/g" });
    });

    /**
     * toPlainJson should turn NaN and the infinities into null, as JSON does.
     */
    it("should write non-finite numbers as null", () => {
        expect(toPlainJson([NaN, Infinity, -Infinity, 1.5])).toEqual([null, null, null, 1.5]);
    });

    /**
     * toPlainJson should honor toJSON(), and make a fresh copy that shares nothing with the input.
     *
     * toPlainJson({ toJSON: () => ({ a: 1 }) });   // -> { a: 1 }
     */
    it("should honor toJSON and return a fresh copy", () => {
        const input = { nested: { list: [1, { x: true }] }, nil: null, s: "s" };
        const copy = toPlainJson(input) as typeof input;

        expect(copy).toEqual(input);
        expect(copy.nested).not.toBe(input.nested);
        expect(toPlainJson({ toJSON: () => ({ a: 1 }) })).toEqual({ a: 1 });

        class Point {
            constructor(readonly x: number) {}
        }

        expect(toPlainJson(new Point(3))).toEqual({ x: 3 });
    });

    /**
     * toPlainJson should keep a key named __proto__ as an ordinary key, never as the prototype.
     */
    it("should keep __proto__ as an own key", () => {
        const input = JSON.parse('{"__proto__": {"polluted": true}}') as object;
        const copy = toPlainJson(input) as Record<string, unknown>;

        expect(Object.hasOwn(copy, "__proto__")).toBe(true);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    /**
     * toPlainJson should refuse a value that contains itself, and allow a value used twice.
     */
    it("should throw on cycles but allow repeated values", () => {
        const loop: Record<string, unknown> = {};

        loop.self = loop;
        expect(() => toPlainJson(loop)).toThrow("refers to itself");

        const shared = { a: 1 };

        expect(toPlainJson([shared, shared])).toEqual([{ a: 1 }, { a: 1 }]);
    });
});

describe("deepEqual()", () => {
    /**
     * deepEqual should compare arrays item by item and objects key by key, ignoring key order.
     *
     * deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] });   // -> true
     */
    it("should compare structures", () => {
        expect(deepEqual({ a: [1, { b: 2 }], c: null }, { c: null, a: [1, { b: 2 }] })).toBe(true);
        expect(deepEqual([1, 2], [1, 2, 3])).toBe(false);
        expect(deepEqual([1, 2], [1, 3])).toBe(false);
        expect(deepEqual([1], { 0: 1 })).toBe(false);
        expect(deepEqual({ 0: 1 }, [1])).toBe(false);
        expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
        expect(deepEqual({ a: 1, c: 1 }, { a: 1, b: 1 })).toBe(false);
        expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
        expect(deepEqual(1, "1")).toBe(false);
        expect(deepEqual(null, {})).toBe(false);
        expect(deepEqual({}, null)).toBe(false);
        expect(deepEqual("a", "a")).toBe(true);
    });
});

describe("stableStringify()", () => {
    /**
     * stableStringify should sort keys, so equal values give equal text.
     *
     * stableStringify({ b: 1, a: [true] });   // -> '{"a":[true],"b":1}'
     */
    it("should sort keys at every depth", () => {
        expect(stableStringify({ b: 1, a: [true, { d: 1, c: 2 }] })).toBe('{"a":[true,{"c":2,"d":1}],"b":1}');
        expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    });

    /**
     * stableStringify should give "undefined" for undefined, skip undefined keys, and write
     * undefined array items as null.
     */
    it("should handle undefined", () => {
        expect(stableStringify(undefined)).toBe("undefined");
        expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
        expect(stableStringify([undefined])).toBe("[null]");
        expect(stableStringify(() => 0)).toBe("undefined");
        expect(stableStringify("x")).toBe('"x"');
    });
});

describe("deepFreeze()", () => {
    /**
     * deepFreeze should freeze a value and everything inside it, and return it.
     *
     * const config = deepFreeze({ a: { b: [1] } });
     * Object.isFrozen(config.a.b);   // -> true
     */
    it("should freeze all the way down", () => {
        const value = { a: { b: [1, { c: 1 }] } };

        expect(deepFreeze(value)).toBe(value);
        expect(Object.isFrozen(value.a.b[1])).toBe(true);
        expect(deepFreeze(3)).toBe(3);
    });

    /**
     * deepFreeze should skip a value that is already frozen, taking it to be frozen all the way down.
     */
    it("should skip values already frozen", () => {
        const inner = { x: 1 };
        const outer = Object.freeze({ inner });

        deepFreeze(outer);
        expect(Object.isFrozen(inner)).toBe(false);
    });
});

describe("getAtPath()", () => {
    /**
     * getAtPath should read through objects and arrays, and give undefined for anything missing
     * or of the wrong kind.
     *
     * getAtPath({ targets: [{ id: "a" }] }, ["targets", 0, "id"]);   // -> "a"
     */
    it("should read nested values", () => {
        const root = { targets: [{ id: "a" }], s: "x" };

        expect(getAtPath(root, ["targets", 0, "id"])).toBe("a");
        expect(getAtPath(root, [])).toBe(root);
        expect(getAtPath(root, ["targets", 3])).toBeUndefined();
        expect(getAtPath(root, ["targets", "0"])).toBeUndefined();
        expect(getAtPath(root, ["s", "length"])).toBeUndefined();
        expect(getAtPath(root, ["toString"])).toBeUndefined();
        expect(getAtPath(undefined, ["a"])).toBeUndefined();
        expect(child({ a: 1 }, 0)).toBeUndefined();
    });
});

describe("typeOfValue()", () => {
    /**
     * typeOfValue should name the kind of a JSON value, or "missing".
     *
     * typeOfValue([1]);   // -> "array"
     */
    it("should name every kind", () => {
        expect([undefined, null, [], {}, "s", 1, true].map((value) => typeOfValue(value as never)))
            .toEqual(["missing", "null", "array", "object", "string", "number", "boolean"]);
        expect(isJsonObject([])).toBe(false);
        expect(isJsonObject({})).toBe(true);
    });
});

describe("setOwn()", () => {
    /**
     * setOwn should set ordinary keys and __proto__ alike as own properties.
     */
    it("should set own properties", () => {
        const target = {};

        setOwn(target, "a", 1);
        setOwn(target, "__proto__", 2);
        expect(Object.getOwnPropertyDescriptor(target, "__proto__")?.value).toBe(2);
        expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    });
});
