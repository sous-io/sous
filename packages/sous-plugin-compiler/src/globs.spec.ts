/**
 * The order of the files in a glob include (`compareIncludeOrder`). The table is the one Luke
 * confirmed for the new sort: a folder's own files before its sub-folders, case ignored, one
 * character at a time, `_` first, then digits, then letters.
 */

import { describe, expect, it } from "vitest";
import { compareIncludeOrder } from "./globs.js";

/** The 21 files of the confirmed table, in the order they must come out. */
const CONFIRMED_ORDER = [
    "memories/_intro.md",
    "memories/0002-setup.md",
    "memories/0010-setup.md",
    "memories/0020-setup.md",
    "memories/10-setup.md",
    "memories/2-setup.md",
    "memories/apple.md",
    "memories/build.md",
    "memories/Zebra.md",
    "memories/_private/_a.md",
    "memories/_private/a.md",
    "memories/2-guides/_notes.md",
    "memories/2-guides/0002-first.md",
    "memories/2-guides/0010-second.md",
    "memories/2-guides/Alpha.md",
    "memories/2-guides/beta.md",
    "memories/2-guides/deep/note.md",
    "memories/Api/Overview.md",
    "memories/Api/routes.md",
    "memories/Api/auth/Tokens.md",
    "memories/zeta/last.md",
];

describe("compareIncludeOrder", () => {
    /** Every row of the confirmed table, from a reversed and from a bytewise start. */
    it("should give the confirmed order of the 21-row table", () => {
        expect([...CONFIRMED_ORDER].reverse().sort(compareIncludeOrder)).toEqual(CONFIRMED_ORDER);
        expect([...CONFIRMED_ORDER].sort().sort(compareIncludeOrder)).toEqual(CONFIRMED_ORDER);
    });

    /** The same table as absolute paths, with either separator. */
    it("should order absolute paths and paths with backslashes the same way", () => {
        const absolute = CONFIRMED_ORDER.map((file) => `/home/p/.sous/${file}`);
        const windows = CONFIRMED_ORDER.map((file) => `C:\\p\\${file.replaceAll("/", "\\")}`);

        expect([...absolute].reverse().sort(compareIncludeOrder)).toEqual(absolute);
        expect([...windows].reverse().sort(compareIncludeOrder)).toEqual(windows);
    });

    /** A folder's own file comes before a sub-folder's, whatever the names. */
    it("should put a folder's own files before its sub-folders", () => {
        expect(compareIncludeOrder("m/zzz.md", "m/aaa/x.md")).toBeLessThan(0);
        expect(compareIncludeOrder("m/api/routes.md", "m/apple.md")).toBeGreaterThan(0);
    });

    /** `_` comes before every other character, including `-` and `.`. */
    it("should put _ before every other character", () => {
        expect(compareIncludeOrder("a_b.md", "a-b.md")).toBeLessThan(0);
        expect(compareIncludeOrder("a_b.md", "a.md")).toBeLessThan(0);
        expect(compareIncludeOrder("_z.md", "0.md")).toBeLessThan(0);
    });

    /** Case is ignored, but a capitalised name comes before its lower-case twin. */
    it("should ignore case, and put the capitalised one of two twins first", () => {
        expect(compareIncludeOrder("apple.md", "Zebra.md")).toBeLessThan(0);
        expect(compareIncludeOrder("Readme.md", "readme.md")).toBeLessThan(0);
        expect(compareIncludeOrder("readme.md", "Readme.md")).toBeGreaterThan(0);
        expect(compareIncludeOrder("same.md", "same.md")).toBe(0);
    });

    /** A name that is the start of another comes first. */
    it("should put a shorter name first when it starts the longer one", () => {
        expect(compareIncludeOrder("note", "notes")).toBeLessThan(0);
    });
});
