import { describe, expect, it } from "vitest";
import { includeReference, memoriesContent } from "./targets.js";

/** `host.globs.toPosix` as it behaves on Windows, where `\` is the separator. */
const windowsToPosix = (file: string) => file.split("\\").join("/");

/** `host.globs.toPosix` as it behaves on Linux and macOS. */
const posixToPosix = (file: string) => file;

describe("includeReference()", () => {
    /**
     * The compiler and Claude Code read an `@` reference only up to the first `\` that does not
     * escape a space, so a Windows path is written with `/` separators.
     *
     * includeReference("D:\\Projects\\hub\\.sous\\MEMORIES.tpl.md", windowsToPosix);
     * // -> "@D:/Projects/hub/.sous/MEMORIES.tpl.md"
     */
    it("should write a Windows path with forward slashes", () => {
        expect(includeReference("D:\\Projects\\hub\\.sous\\MEMORIES.tpl.md", windowsToPosix)).toBe("@D:/Projects/hub/.sous/MEMORIES.tpl.md");
    });

    /**
     * A space ends a reference, so each one is escaped as `\ `.
     *
     * includeReference("C:\\Users\\Jane Doe\\.sous\\m.md", windowsToPosix); // -> "@C:/Users/Jane\\ Doe/.sous/m.md"
     * includeReference("/home/jane doe/m.md", posixToPosix);                // -> "@/home/jane\\ doe/m.md"
     */
    it("should escape each space", () => {
        expect(includeReference("C:\\Users\\Jane Doe\\.sous\\m.md", windowsToPosix)).toBe("@C:/Users/Jane\\ Doe/.sous/m.md");
        expect(includeReference("/home/jane doe/m.md", posixToPosix)).toBe("@/home/jane\\ doe/m.md");
    });
});

describe("memoriesContent()", () => {
    /**
     * On Windows the project's source is written with `/` separators, so the compiler reads the
     * whole path instead of only the drive (`D:`).
     *
     * project D:\Projects\hub, .sous\MEMORIES.tpl.md exists
     * // -> "@D:/Projects/hub/.sous/MEMORIES.tpl.md"
     */
    it("should write the project's source with forward slashes on Windows", () => {
        const content = memoriesContent(
            {},
            {
                project: { root: "D:\\Projects\\hub", sousDir: "D:\\Projects\\hub\\.sous" },
                selected: [],
                exists: () => true,
                toPosix: windowsToPosix,
            },
        );

        expect(content).toBe("@D:/Projects/hub/.sous/MEMORIES.tpl.md");
    });

    /**
     * With no `MEMORIES.tpl.md`, each recipe memory is written as its own reference, with `/`
     * separators and spaces escaped.
     *
     * memories at C:\Users\Jane Doe\.sous\store\a\one\memories\m.md and ...\b\two\memories\n.md
     * // -> "@C:/Users/Jane\\ Doe/.sous/store/a/one/memories/m.md\n\n@C:/Users/Jane\\ Doe/.sous/store/b/two/memories/n.md"
     */
    it("should write each recipe memory with forward slashes and escaped spaces on Windows", () => {
        const store = "C:\\Users\\Jane Doe\\.sous\\store";
        const content = memoriesContent(
            {},
            {
                project: { root: "D:\\Projects\\hub", sousDir: "D:\\Projects\\hub\\.sous" },
                selected: [
                    { recipe: "a/one", repository: "r", name: "m.md", path: `${store}\\a\\one\\memories\\m.md` },
                    { recipe: "b/two", repository: "r", name: "n.md", path: `${store}\\b\\two\\memories\\n.md` },
                ],
                exists: () => false,
                toPosix: windowsToPosix,
            },
        );

        expect(content).toBe("@C:/Users/Jane\\ Doe/.sous/store/a/one/memories/m.md\n\n@C:/Users/Jane\\ Doe/.sous/store/b/two/memories/n.md");
    });
});
