import { describe, expect, it } from "vitest";
import { HTML_COMMENTS, managedBlockMarkers, parseLines } from "./lines.js";

/** A hand-kept .gitignore with comments and blank lines. */
const GITIGNORE = `# dependencies
node_modules/

# build output
dist/
`;

describe("managedBlockMarkers()", () => {
    /**
     * managedBlockMarkers should write the two agreed marker lines in the file's comment style.
     *
     * managedBlockMarkers("session-files").open;   // "# >>> sous managed: session-files (do not edit between these markers)"
     */
    it("should write the markers in a comment style", () => {
        expect(managedBlockMarkers("session-files")).toEqual({
            open: "# >>> sous managed: session-files (do not edit between these markers)",
            close: "# <<< sous managed: session-files",
        });
        expect(managedBlockMarkers("rules", HTML_COMMENTS)).toEqual({
            open: "<!-- >>> sous managed: rules (do not edit between these markers) -->",
            close: "<!-- <<< sous managed: rules -->",
        });
        expect(() => managedBlockMarkers(" ")).toThrow("one line of text");
        expect(() => managedBlockMarkers("a\nb")).toThrow("one line of text");
    });
});

describe("LinesDocument", () => {
    /**
     * includes and indexOf should compare whole lines exactly; an untouched file prints back
     * byte for byte.
     */
    it("should read lines", () => {
        const file = parseLines(GITIGNORE);

        expect(file.lines()).toEqual(["# dependencies", "node_modules/", "", "# build output", "dist/"]);
        expect(file.length()).toBe(5);
        expect(file.includes("dist/")).toBe(true);
        expect(file.includes("dist")).toBe(false);
        expect(file.indexOf("node_modules/")).toBe(1);
        expect(file.toString()).toBe(GITIGNORE);
        expect(file.changed()).toBe(false);
        expect(parseLines("").lines()).toEqual([]);
    });

    /**
     * insert should add lines at the end (the default), the start, after or before a line (at
     * the end when that line is missing), or at a line number counted from 1.
     *
     * file.insert(".env", { after: "# dependencies" });
     */
    it("should insert lines at every position", () => {
        const file = parseLines(GITIGNORE);

        file.insert("*.log");
        file.insert("# top", "start");
        file.insert(".env", { after: "# dependencies" });
        file.insert("coverage/", { before: "dist/" });
        file.insert("third", { line: 3 });
        file.insert("tail", { after: "# not there" });
        file.insert("far", { line: 99 });
        file.insert([]);

        expect(file.toString()).toBe("# top\n# dependencies\nthird\n.env\nnode_modules/\n\n# build output\ncoverage/\ndist/\n*.log\ntail\nfar\n");
        expect(file.changed()).toBe(true);
        expect(() => file.insert("x", { line: 0 })).toThrow(RangeError);
        expect(() => file.insert("x", { line: 1.5 })).toThrow(RangeError);
        expect(() => file.insert("a\nb")).toThrow("line break");
    });

    /** remove should remove every equal line and say how many. */
    it("should remove lines", () => {
        const file = parseLines("a\nb\na\n");

        expect(file.remove("a")).toBe(2);
        expect(file.remove("z")).toBe(0);
        expect(file.toString()).toBe("b\n");
    });

    /**
     * replaceLines and setLines should change only the lines in range or that differ, keeping
     * every other line's ending, and a missing final line break missing.
     *
     * parseLines("a\r\nb\nc").setLines(["a", "x", "c"]);   // "a\r\nx\r\nc"
     */
    it("should replace a range of lines and set the lines, changing only what differs", () => {
        const file = parseLines("a\r\nb\nc");

        file.setLines(["a", "x", "c"]);
        expect(file.toString()).toBe("a\r\nx\r\nc");

        file.replaceLines(1, 1, []);
        expect(file.toString()).toBe("a\r\nc");

        file.replaceLines(0, 0, ["first"]);
        expect(file.lines()).toEqual(["first", "a", "c"]);
        expect(() => file.replaceLines(2, 5, [])).toThrow(RangeError);

        const same = parseLines("a\nb\n");

        same.setLines(["a", "b"]);
        expect(same.changed()).toBe(false);
        expect(same.toString()).toBe("a\nb\n");
    });

    /**
     * Each line should keep its own line ending; new lines take the file's; a file with no
     * final line break keeps having none; an empty file gets one.
     */
    it("should keep line endings", () => {
        const crlf = parseLines("a\r\nb\r\n");

        crlf.insert("c");
        expect(crlf.toString()).toBe("a\r\nb\r\nc\r\n");

        const mixed = parseLines("a\r\nb\n");

        mixed.insert("c", { after: "a" });
        expect(mixed.toString()).toBe("a\r\nc\r\nb\n");

        const noFinal = parseLines("a\nb");

        noFinal.insert("c");
        expect(noFinal.toString()).toBe("a\nb\nc");
        noFinal.remove("c");
        expect(noFinal.toString()).toBe("a\nb");

        const empty = parseLines("");

        empty.insert("a");
        expect(empty.toString()).toBe("a\n");
    });

    /**
     * setBlock should add a missing block with its markers, at the end after a blank line by
     * default; setting it again should change only what is between the markers; removeBlock
     * should take it away with its blank line, giving the original text back.
     */
    it("should keep a named block", () => {
        const file = parseLines(GITIGNORE, { label: ".gitignore" });

        expect(file.block("sessions")).toBeUndefined();
        file.setBlock("sessions", ["docs/context/.kw-session-*"]);
        expect(file.toString()).toBe(`${GITIGNORE}
# >>> sous managed: sessions (do not edit between these markers)
docs/context/.kw-session-*
# <<< sous managed: sessions
`);
        expect(file.block("sessions")).toEqual(["docs/context/.kw-session-*"]);
        expect(file.hasBlock("sessions")).toBe(true);

        file.setBlock("sessions", ["a", "b"]);
        expect(file.block("sessions")).toEqual(["a", "b"]);
        file.setBlock("sessions", []);
        expect(file.block("sessions")).toEqual([]);

        expect(file.removeBlock("sessions")).toBe(true);
        expect(file.removeBlock("sessions")).toBe(false);
        expect(file.toString()).toBe(GITIGNORE);
    });

    /**
     * A block at the start should be followed by a blank line, which removing it takes away too;
     * a block after a line goes right there.
     */
    it("should place a block at a position", () => {
        const start = parseLines("a\n");

        start.setBlock("x", ["1"], "start");
        expect(start.toString()).toBe("# >>> sous managed: x (do not edit between these markers)\n1\n# <<< sous managed: x\n\na\n");
        start.removeBlock("x");
        expect(start.toString()).toBe("a\n");

        const after = parseLines("a\nb\n", { comment: HTML_COMMENTS });

        after.setBlock("x", ["1"], { after: "a" });
        expect(after.toString()).toBe("a\n<!-- >>> sous managed: x (do not edit between these markers) -->\n1\n<!-- <<< sous managed: x -->\nb\n");

        const unchanged = parseLines("# >>> sous managed: x (do not edit between these markers)\n1\n# <<< sous managed: x\n");

        unchanged.setBlock("x", ["1"]);
        expect(unchanged.changed()).toBe(false);
    });

    /**
     * A block whose markers are damaged should be an error naming the file, never a guess: an
     * opening line with no closing line, a closing line with no opening line, or a marker twice.
     */
    it("should refuse a damaged block", () => {
        const open = "# >>> sous managed: x (do not edit between these markers)";
        const close = "# <<< sous managed: x";

        expect(() => parseLines(`${open}\na\n`, { label: ".gitignore" }).setBlock("x", [])).toThrow('The sous managed block "x" in .gitignore is damaged.');
        expect(() => parseLines(`a\n${close}\n`).block("x")).toThrow("is damaged");
        expect(() => parseLines(`${close}\n${open}\n`).removeBlock("x")).toThrow("is damaged");
        expect(() => parseLines(`${open}\n${close}\n${open}\n${close}\n`).hasBlock("x")).toThrow("is damaged");
        expect(parseLines(`${open}\n${close}\n`).block("other")).toBeUndefined();
    });

    /**
     * A block added to the end of a file should follow host.gitignore's rule (a blank line
     * before it unless there is one), except that a file with no final line break keeps having
     * none; an empty file gets just the block.
     */
    it("should separate a block at the end as host.gitignore does", () => {
        const block = "# >>> sous managed: x (do not edit between these markers)\none\n# <<< sous managed: x";
        const placed = (text: string): string => {
            const file = parseLines(text);

            file.setBlock("x", ["one"]);

            return file.toString();
        };

        expect(placed("a\n\n")).toBe(`a\n\n${block}\n`);
        expect(placed("a\n")).toBe(`a\n\n${block}\n`);
        expect(placed("a")).toBe(`a\n\n${block}`);
        expect(placed("")).toBe(`${block}\n`);
    });
});
