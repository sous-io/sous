import { describe, expect, it } from "vitest";
import { buildRefs } from "../test/fixtures.js";
import { isGlobName, splitSegments } from "./names.js";


describe("isGlobName()", () => {
    /**
     * A glob that could stand for a name holds glob syntax and only name-like characters.
     *
     * isGlobName("work*") // -> true;  isGlobName("a b*") // -> false
     */
    it("should recognize a glob standing for a name", async () => {
        const globs = (await buildRefs()).ctx.services.get("host.globs");

        for (const text of ["*", "a?", "[ab]", "{a,b}", "**", "work*"]) {
            expect(isGlobName(text, globs), text).toBe(true);
        }

        expect(isGlobName("a b*", globs)).toBe(false);
        expect(isGlobName("plain", globs)).toBe(false);
    });
});

describe("splitSegments()", () => {
    /**
     * Text splits at `/` except inside braces; empty segments are kept for the parser to report.
     *
     * splitSegments("a/{b/c,d}/e") // -> ["a", "{b/c,d}", "e"]
     */
    it("should keep brace groups whole", () => {
        expect(splitSegments("a/{b/c,d}/e")).toEqual(["a", "{b/c,d}", "e"]);
        expect(splitSegments("a//b")).toEqual(["a", "", "b"]);
    });
});
