import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apply, makeTmpDir, read, write, type TestEntry } from "../test/helpers.js";
import { failureReport, silenceCovers } from "./apply.js";

let tmp: { path: string; cleanup(): void };

beforeEach(() => {
    tmp = makeTmpDir();
});

afterEach(() => {
    tmp.cleanup();
});

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const settings = () => JSON.parse(read(tmp.path, ".claude/settings.json") ?? "null");

const allow = (items: string[], by = "voltagrid/session-harness"): TestEntry => ({
    entry: { file: ".claude/settings.json", recipe: by, ensureIncludes: { path: "permissions.allow", items } },
});

describe("applyEdits()", () => {
    /**
     * Declared entries are applied, recorded, and undone when they are no longer declared: only
     * the items Sous added are removed, and someone else's are kept.
     *
     * build 1: ensureIncludes ["a"]   -> allow: ["x", "a"]
     * build 2: nothing declared       -> allow: ["x"]
     */
    it("should apply an entry, keep the history, and undo it when it is no longer declared", async () => {
        write(tmp.path, ".claude/settings.json", json({ permissions: { allow: ["x"] } }));

        const first = await apply(tmp.path, [allow(["a"])]);

        expect(first.result.ok).toBe(true);
        expect(settings().permissions.allow).toEqual(["x", "a"]);

        const history = JSON.parse(read(tmp.path, ".sous/sous.edits.json")!);

        expect(history.entries).toHaveLength(1);
        expect(history.entries[0].declarer).toBe("voltagrid/session-harness");
        expect(history.entries[0].file).toBe(".claude/settings.json");

        const again = await apply(tmp.path, [allow(["a"])]);

        expect(again.result.files[0]!.action).toBe("unchanged");

        await apply(tmp.path, []);

        expect(settings().permissions.allow).toEqual(["x"]);
        expect(JSON.parse(read(tmp.path, ".sous/sous.edits.json")!).entries).toEqual([]);
    });

    /**
     * A changed value is the old entry going and a new one coming, in one pass: the old value is
     * restored, then the new one set, and the file is written once.
     */
    it("should undo the old entry and apply the new one when a value changes", async () => {
        write(tmp.path, ".claude/settings.json", json({ env: { MODE: "loose" } }));

        const set = (value: string): TestEntry => ({ entry: { file: ".claude/settings.json", set: { path: "env.MODE", value } } });

        await apply(tmp.path, [set("strict")]);
        expect(settings().env.MODE).toBe("strict");

        await apply(tmp.path, [set("paranoid")]);
        expect(settings().env.MODE).toBe("paranoid");

        await apply(tmp.path, []);
        expect(settings().env.MODE).toBe("loose");
    });

    /**
     * Nothing is undone when undoing is not allowed (a config build that failed).
     */
    it("should not undo anything when undo is off", async () => {
        write(tmp.path, ".claude/settings.json", json({}));
        await apply(tmp.path, [allow(["a"])]);
        await apply(tmp.path, [], { undo: false });

        expect(settings().permissions.allow).toEqual(["a"]);
        expect(JSON.parse(read(tmp.path, ".sous/sous.edits.json")!).entries).toHaveLength(1);
    });

    /**
     * While an entry is declared Sous applies it on every build, putting back a value someone
     * changed; what it did is said only in debug output.
     */
    it("should put back a value someone changed and say so only in debug output", async () => {
        write(tmp.path, ".claude/settings.json", json({}));

        const entry: TestEntry = { entry: { file: ".claude/settings.json", set: { path: "a", value: 1 } } };

        await apply(tmp.path, [entry]);
        write(tmp.path, ".claude/settings.json", json({ a: 2 }));

        const { reporter } = await apply(tmp.path, [entry]);

        expect(settings().a).toBe(1);
        expect(reporter.at("warning")).toEqual([]);
        expect(reporter.at("info")).toEqual([]);
        expect(reporter.at("debug").join("\n")).toMatch(/Applied set at a/);
    });

    /**
     * A missing file is created with just the declared content, and removed by a rollback (after a
     * backup), since its previous state was "no file".
     */
    it("should create a missing file and remove it, backed up, on rollback", async () => {
        const entry: TestEntry = { entry: { file: ".claude/settings.json", set: { path: "env.A", value: "1" } } };
        const first = await apply(tmp.path, [entry]);

        expect(first.result.files[0]!.action).toBe("created");
        expect(settings()).toEqual({ env: { A: "1" } });

        const second = await apply(tmp.path, []);

        expect(read(tmp.path, ".claude/settings.json")).toBeUndefined();
        expect(second.result.files[0]!.action).toBe("removed");
        expect(second.result.files[0]!.backups).toHaveLength(1);
        expect(fs.existsSync(second.result.files[0]!.backups![0]!)).toBe(true);
    });

    /**
     * An unparseable file is skipped with a warning, left exactly as it is, and its assertions
     * fail; the automatic ones as warnings, so the build does not fail.
     */
    it("should skip an unparseable file with a warning and fail its assertions", async () => {
        write(tmp.path, ".claude/settings.json", "{ not json");

        const { result, reporter } = await apply(tmp.path, [allow(["a"])]);

        expect(read(tmp.path, ".claude/settings.json")).toBe("{ not json");
        expect(result.ok).toBe(true);
        expect(result.files[0]!.action).toBe("skipped");
        expect(reporter.at("warning").join("\n")).toMatch(/cannot parse/);
        expect(result.assertions.some((outcome) => !outcome.passed && outcome.automatic)).toBe(true);
    });

    /**
     * An author's assertion at level error that fails stops that file being written and makes the
     * result not ok; with ignoreFailedAssertions it is a warning and the file is written.
     */
    it("should fail on an author's error assertion unless failures are ignored", async () => {
        write(tmp.path, ".claude/settings.json", json({ permissions: { allow: [] } }));

        const entries: TestEntry[] = [
            { entry: { file: ".claude/settings.json", set: { path: "env.A", value: "1" } } },
            {
                entry: {
                    file: ".claude/settings.json",
                    assert: { path: "permissions.allow", includes: "Bash(git-commit.sh:*)", message: "The harness cannot commit without this rule." },
                },
            },
        ];
        const failed = await apply(tmp.path, entries);

        expect(failed.result.ok).toBe(false);
        expect(failed.result.files[0]!.action).toBe("not-written");
        expect(settings().env).toBeUndefined();
        expect(failed.reporter.at("error")[0]).toContain('expects it to include "Bash(git-commit.sh:*)".');
        expect(failed.reporter.at("error")[0]).toContain("The harness cannot commit without this rule.");

        const ignored = await apply(tmp.path, entries, { ignoreFailedAssertions: true });

        expect(ignored.result.ok).toBe(true);
        expect(settings().env.A).toBe("1");
        expect(ignored.reporter.at("warning")[0]).toContain("Assertion failed");
    });

    /**
     * Two declarers set different values at one path: the later wins, and the earlier one's
     * automatic assertion warns with the history of the value.
     */
    it("should let the later of two values win and warn with the history", async () => {
        write(tmp.path, ".claude/settings.json", json({}));

        const { result, reporter } = await apply(tmp.path, [
            { entry: { file: ".claude/settings.json", recipe: "a/one", set: { path: "env.MODE", value: "strict" } } },
            { entry: { file: ".claude/settings.json", set: { path: "env.MODE", value: "loose" } }, by: "@sous-io/sous-plugin-config-files" },
        ]);

        expect(result.ok).toBe(true);
        expect(settings().env.MODE).toBe("loose");

        const warning = reporter.at("warning").join("\n");

        expect(warning).toContain("Assertion failed in .claude/settings.json at env.MODE");
        expect(warning).toContain('a/one expects it to equal "strict".');
        expect(warning).toMatch(/1\. a\/one\s+set\s+"strict"/);
        expect(warning).toMatch(/2\. project\s+set\s+"loose"/);
    });

    /**
     * Automatic assertions are not created where the same declarer wrote its own at that path,
     * and can be silenced on one edit, at a path, or for the whole file.
     */
    it("should skip automatic assertions that are duplicated or silenced", async () => {
        write(tmp.path, ".claude/settings.json", json({}));

        const conflicting: TestEntry[] = [
            { entry: { file: ".claude/settings.json", recipe: "a/one", set: { path: "x", value: 1 } } },
            { entry: { file: ".claude/settings.json", recipe: "b/two", set: { path: "x", value: 2 } } },
        ];

        const own = await apply(tmp.path, [
            ...conflicting,
            { entry: { file: ".claude/settings.json", recipe: "a/one", assert: { path: "x", exists: true } } },
        ]);

        expect(own.reporter.at("warning")).toEqual([]);

        const perEdit = await apply(tmp.path, [
            { entry: { file: ".claude/settings.json", recipe: "a/one", set: { path: "x", value: 1, assertion: "none" } } },
            conflicting[1]!,
        ]);

        expect(perEdit.reporter.at("warning")).toEqual([]);

        const atPath = await apply(tmp.path, [...conflicting, { entry: { file: ".claude/settings.json", recipe: "a/one", silence: { path: "x" } } }]);

        expect(atPath.reporter.at("warning")).toEqual([]);
        expect(atPath.result.assertions.some((outcome) => outcome.silenced)).toBe(true);

        const otherDeclarer = await apply(tmp.path, [...conflicting, { entry: { file: ".claude/settings.json", recipe: "b/two", silence: {} } }]);

        expect(otherDeclarer.reporter.at("warning")).toHaveLength(1);
    });

    /**
     * `once` applies the entry on the first run only; a person's later change stays.
     */
    it("should apply a once entry only on the first run", async () => {
        write(tmp.path, ".claude/settings.json", json({}));

        const entry: TestEntry = { entry: { file: ".claude/settings.json", once: true, set: { path: "a", value: 1 } } };

        await apply(tmp.path, [entry]);
        write(tmp.path, ".claude/settings.json", json({ a: 5 }));
        await apply(tmp.path, [entry]);

        expect(settings().a).toBe(5);
    });

    /**
     * `rollback: false` leaves the result in place when the entry goes.
     */
    it("should leave the result in place with rollback off", async () => {
        write(tmp.path, ".gitignore", "node_modules/\n");
        await apply(tmp.path, [{ entry: { file: ".gitignore", rollback: false, ensureLine: { line: "x" } } }]);
        await apply(tmp.path, []);

        expect(read(tmp.path, ".gitignore")).toBe("node_modules/\nx\n");
    });

    /**
     * `backupBeforeChange` copies the file before Sous alters it.
     */
    it("should back up the file before changing it with backupBeforeChange", async () => {
        write(tmp.path, ".gitignore", "a\n");

        const { result } = await apply(tmp.path, [{ entry: { file: ".gitignore", backupBeforeChange: true, ensureLine: { line: "b" } } }]);

        expect(result.files[0]!.backups).toHaveLength(1);
        expect(fs.readFileSync(result.files[0]!.backups![0]!, "utf8")).toBe("a\n");
    });

    /**
     * Starter files and folders (spec 12): folders are created level by level; a rollback removes
     * the starter file (backed up) and the folders Sous created that are empty, deepest first, and
     * leaves a folder with content in it.
     */
    it("should create starter files and folders and roll them back safely", async () => {
        const entries: TestEntry[] = [
            { entry: { ensureDirectoryExists: { paths: ["docs/context", "docs/work", "comms"] } } },
            { entry: { file: ".kw/descriptor.json", ensureFileExists: { content: { version: 1 } } } },
            { entry: { file: ".gitignore", ensureLine: { line: "docs/context/.kw-session-*" } } },
        ];
        const first = await apply(tmp.path, entries);

        expect(first.result.directories.created.map((dir) => path.relative(tmp.path, dir)).sort()).toEqual(["comms", "docs", "docs/context", "docs/work"]);
        expect(JSON.parse(read(tmp.path, ".kw/descriptor.json")!)).toEqual({ version: 1 });

        write(tmp.path, ".kw/descriptor.json", json({ version: 1, edited: true }));
        write(tmp.path, "docs/work/note.md", "mine");

        const second = await apply(tmp.path, entries);

        expect(JSON.parse(read(tmp.path, ".kw/descriptor.json")!)).toEqual({ version: 1, edited: true });
        expect(second.result.directories.created).toEqual([]);

        const third = await apply(tmp.path, []);

        expect(read(tmp.path, ".kw/descriptor.json")).toBeUndefined();
        expect(read(tmp.path, ".gitignore")).toBeUndefined();
        expect(fs.existsSync(path.join(tmp.path, "docs/context"))).toBe(false);
        expect(fs.existsSync(path.join(tmp.path, "comms"))).toBe(false);
        expect(fs.existsSync(path.join(tmp.path, "docs/work/note.md"))).toBe(true);

        const descriptor = third.result.files.find((file) => file.file === ".kw/descriptor.json")!;

        expect(JSON.parse(fs.readFileSync(descriptor.backups![0]!, "utf8"))).toEqual({ version: 1, edited: true });
    });

    /**
     * A folder that was already there is never removed by a rollback.
     */
    it("should not remove a folder that existed before", async () => {
        fs.mkdirSync(path.join(tmp.path, "comms"));
        await apply(tmp.path, [{ entry: { ensureDirectoryExists: { paths: ["comms"] } } }]);
        await apply(tmp.path, []);

        expect(fs.existsSync(path.join(tmp.path, "comms"))).toBe(true);
    });

    /**
     * Size checks: bytes, characters and tokens against the file about to be written.
     */
    it("should check sizes in bytes, characters and tokens", async () => {
        write(tmp.path, "AGENTS.md", "one two three four\n");

        const { result } = await apply(tmp.path, [
            { entry: { file: "AGENTS.md", assert: { maxBytes: 10, level: "warn" } } },
            { entry: { file: "AGENTS.md", assert: { maxCharacters: 100 } } },
            { entry: { file: "AGENTS.md", assert: { maxTokens: 3, level: "warn" } } },
            { entry: { file: "AGENTS.md", assert: { minTokens: 4 } } },
        ]);

        expect(result.assertions.map((outcome) => [outcome.check, outcome.passed])).toEqual([
            ["maxBytes", false],
            ["maxCharacters", true],
            ["maxTokens", false],
            ["minTokens", true],
        ]);
        expect(result.ok).toBe(true);
    });

    /**
     * A file or folder assertion: `fileExists: false` and `fileDoesNotExist: true` mean the same,
     * and pass on a missing file; a value assertion on a missing file fails.
     */
    it("should check whether a file exists, both spellings", async () => {
        const { result } = await apply(tmp.path, [
            { entry: { file: "old/plugin.json", assert: { fileExists: false } } },
            { entry: { file: "old/plugin.json", assert: { fileDoesNotExist: true } } },
            { entry: { file: "old/plugin.json", assert: { path: "a", exists: true, level: "warn" } } },
        ]);

        expect(result.assertions.map((outcome) => outcome.passed)).toEqual([true, true, false]);
    });

    /**
     * A file outside the project is edited like any other, and its history is kept by the
     * project. Two projects declaring the same line: the second records nothing to undo, so its
     * rollback leaves the line.
     */
    it("should edit a file outside the project and keep each project's own record", async () => {
        const outside = makeTmpDir("sous-editor-outside-");
        const projectA = path.join(tmp.path, "a");
        const projectB = path.join(tmp.path, "b");
        const file = path.join(outside.path, "settings.txt");
        const entry: TestEntry = { entry: { file, ensureLine: { line: "shared" } } };

        try {
            fs.mkdirSync(projectA);
            fs.mkdirSync(projectB);
            fs.writeFileSync(file, "x\n");

            await apply(projectA, [entry]);
            await apply(projectB, [entry]);
            expect(fs.readFileSync(file, "utf8")).toBe("x\nshared\n");

            await apply(projectB, []);
            expect(fs.readFileSync(file, "utf8")).toBe("x\nshared\n");

            await apply(projectA, []);
            expect(fs.readFileSync(file, "utf8")).toBe("x\n");

            expect(JSON.parse(read(projectA, ".sous/sous.edits.json")!).entries).toEqual([]);
        } finally {
            outside.cleanup();
        }
    });

    /**
     * A dry run works everything out and writes nothing, not even the history.
     */
    it("should write nothing in a dry run", async () => {
        const { result } = await apply(tmp.path, [allow(["a"])], { dryRun: true });

        expect(result.files[0]!.action).toBe("created");
        expect(read(tmp.path, ".claude/settings.json")).toBeUndefined();
        expect(read(tmp.path, ".sous/sous.edits.json")).toBeUndefined();
    });

    /**
     * Several operation keys in one entry run in their defined order, not the order written:
     * `sort` after `ensureIncludes`.
     */
    it("should run several operation keys in their defined order", async () => {
        write(tmp.path, ".claude/settings.json", json({ permissions: { allow: ["c"] } }));
        await apply(tmp.path, [
            {
                entry: {
                    file: ".claude/settings.json",
                    sort: { path: "permissions.allow" },
                    ensureIncludes: { path: "permissions.allow", items: ["b", "a"] },
                },
            },
        ]);

        expect(settings().permissions.allow).toEqual(["a", "b", "c"]);
    });

    /**
     * An `append` is an action: it acts once, when the entry is first applied, not on every build.
     */
    it("should run an action like append only once per declaration", async () => {
        write(tmp.path, "list.json", json(["a"]));

        const entry: TestEntry = { entry: { file: "list.json", append: { item: "a" } } };

        await apply(tmp.path, [entry]);
        await apply(tmp.path, [entry]);

        expect(JSON.parse(read(tmp.path, "list.json")!)).toEqual(["a", "a"]);

        await apply(tmp.path, []);
        expect(JSON.parse(read(tmp.path, "list.json")!)).toEqual(["a"]);
    });
});

describe("silenceCovers()", () => {
    /**
     * The default scope is this key and everything below it; key-only and below narrow it; kinds
     * and except choose kinds, and `include` is the plugin spelling of `includes`.
     */
    it("should match paths by scope and kinds by kinds or except", () => {
        const base = { path: "permissions", kinds: undefined, except: undefined } as const;

        expect(silenceCovers({ ...base, scope: "key-and-below" }, "permissions.allow", "sorted")).toBe(true);
        expect(silenceCovers({ ...base, scope: "key-only" }, "permissions.allow", "sorted")).toBe(false);
        expect(silenceCovers({ ...base, scope: "key-only" }, "permissions", "sorted")).toBe(true);
        expect(silenceCovers({ ...base, scope: "below" }, "permissions", "sorted")).toBe(false);
        expect(silenceCovers({ ...base, scope: "key-and-below", kinds: ["sorted"] }, "permissions", "unique")).toBe(false);
        expect(silenceCovers({ ...base, scope: "key-and-below", except: ["includes"] }, "permissions", "includes")).toBe(false);
        expect(silenceCovers({ ...base, path: "", scope: "key-and-below" }, "a.b", "equals")).toBe(true);
    });
});

describe("failureReport()", () => {
    /**
     * The failure names the file and path, what the declarer expects, its message, and the edits
     * that touched the value in order (spec 08's wording).
     */
    it("should show the history of the value", () => {
        const text = failureReport(
            ".claude/settings.json",
            { path: "permissions.allow", check: "includes", arg: "Bash(git-commit.sh:*)", not: false, declarer: "voltagrid/session-harness", message: "The session harness cannot commit without this rule.", automatic: false },
            [
                { path: "permissions.allow", declarer: "voltagrid/session-harness", operation: "append", value: '"Bash(git-commit.sh:*)"' },
                { path: "permissions.allow", declarer: "acme/strict-permissions", operation: "set", value: "[]" },
            ],
            undefined,
        );

        expect(text).toBe(
            [
                "Assertion failed in .claude/settings.json at permissions.allow",
                '  voltagrid/session-harness expects it to include "Bash(git-commit.sh:*)".',
                "  The session harness cannot commit without this rule.",
                "",
                "  What changed this value, in order:",
                '    1. voltagrid/session-harness   append   "Bash(git-commit.sh:*)"',
                "    2. acme/strict-permissions     set      []",
            ].join("\n"),
        );
    });
});
