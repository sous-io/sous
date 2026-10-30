import { describe, expect, it } from "vitest";
import { chainOrder, compareBytes, hasExpressions, isExpressionObject, isReservedKey, parseReservedKey } from "./keys.js";

describe("reserved keys", () => {
    it("are the exact list of reserved keys", () => {
        for (const key of ["$expr", "$expr:liquid", "$if", "$if:a", "$elseif", "$elseif:b", "$else", "$if:", "$expr:"]) {
            expect(isReservedKey(key)).toBe(true);
        }

        for (const key of ["$schema", "$iff", "$then", "$elsif", "$else:x", "if", "expr", "$IF"]) {
            expect(isReservedKey(key)).toBe(false);
        }
    });

    it("read the qualifier as a language after $expr: and a name after $if: and $elseif:", () => {
        expect(parseReservedKey("$expr:liquid")).toEqual({ kind: "expr", key: "$expr:liquid", language: "liquid" });
        expect(parseReservedKey("$if:liquid")).toEqual({ kind: "if", key: "$if:liquid", name: "liquid" });
        expect(parseReservedKey("$elseif:02")).toEqual({ kind: "elseif", key: "$elseif:02", name: "02" });
        expect(parseReservedKey("$if:")).toEqual({ kind: "if", key: "$if:", name: "" });
    });

    it("make an object an expression object, alone or mixed", () => {
        expect(isExpressionObject({ $if: "x" })).toBe(true);
        expect(isExpressionObject({ $if: "x", stray: 1 })).toBe(true);
        expect(isExpressionObject({ $schema: "x" })).toBe(false);
        expect(isExpressionObject("$if")).toBe(false);
        expect(isExpressionObject(null)).toBe(false);
        expect(hasExpressions([[{ a: { $else: 1 } }]])).toBe(true);
        expect(hasExpressions({ a: [1, "b", null] })).toBe(false);
    });
});

describe("chain order", () => {
    it("is bytewise: 10 before 2, Z before a, whatever the locale", () => {
        expect(compareBytes("10", "2")).toBeLessThan(0);
        expect(compareBytes("Z", "a")).toBeLessThan(0);
        expect(compareBytes("é", "z")).toBeGreaterThan(0);
    });

    it("puts the unqualified key first, then names in byte order", () => {
        const keys = [{ name: "b" }, { name: "10" }, { name: undefined }, { name: "2" }, { name: "02" }];

        expect(chainOrder(keys).map((key) => key.name)).toEqual([undefined, "02", "10", "2", "b"]);
    });
});
