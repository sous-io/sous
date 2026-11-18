import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir, read, write } from "../test/helpers.js";
import { EditorServiceImpl } from "./service.js";

let tmp: { path: string; cleanup(): void };
let editor: EditorServiceImpl;

beforeEach(() => {
    tmp = makeTmpDir();
    editor = new EditorServiceImpl((file) => path.resolve(tmp.path, file), async (text) => text.length);
});

afterEach(() => {
    tmp.cleanup();
});

describe("EditorServiceImpl", () => {
    /**
     * Direct usage: open a file, apply operations by any name, read values back, get the changed
     * text, write it; undo with the record `apply` returned.
     *
     * editor.open(".claude/settings.json").apply("ensureIncludes", { path: "permissions.allow", items: ["a"] });
     */
    it("should open, apply, read, write and undo", async () => {
        write(tmp.path, ".claude/settings.json", '{\n  // keep\n  "permissions": { "allow": [] }\n}\n');

        const file = editor.open(".claude/settings.json");
        const record = file.apply("ensureIncludes", { path: "permissions.allow", items: ["a"] });

        expect(file.document.atPath("permissions.allow").get()).toEqual(["a"]);
        expect(file.changed()).toBe(true);
        expect(await file.check("includes", "a", { path: "permissions.allow" })).toBe(true);
        expect(file.write()).toBe(true);
        expect(read(tmp.path, ".claude/settings.json")).toContain("// keep");

        file.undo("ensureIncludes", { path: "permissions.allow", items: ["a"] }, record);
        expect(file.document.atPath("permissions.allow").get()).toEqual([]);
    });

    /**
     * Text that is not in a file can be edited too; a missing file opens empty and the first
     * write creates it.
     */
    it("should parse text and create a missing file", () => {
        const text = editor.parse("a\n", "text");

        text.apply("ensureLine", { line: "b" });
        expect(text.text()).toBe("a\nb\n");
        expect(() => text.write()).toThrow(/no file/);

        const missing = editor.open("new.yaml");

        expect(missing.existed).toBe(false);
        missing.apply("set", { path: "a", value: 1 });
        missing.write();
        expect(read(tmp.path, "new.yaml")).toBe("a: 1\n");
        expect(editor.operations().length).toBeGreaterThan(30);
        expect(editor.checks()).toContain("maxTokens");
    });
});
