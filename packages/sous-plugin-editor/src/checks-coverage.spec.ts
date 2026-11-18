import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonObject } from "@sous-io/sous-plugin-api";
import { editorProject, type EditorProject } from "../test/engine.js";
import { makeTmpDir } from "../test/helpers.js";
import { CHECKS } from "./checks.js";

let tmp: { path: string; cleanup(): void };
let project: EditorProject;

/** A JSON file with a value for every value check. */
const DATA = `${JSON.stringify(
    {
        list: ["a", "b", "c"],
        dups: ["b", "a", "b"],
        objs: [
            { id: 1, n: "x" },
            { id: 2, n: "y" },
        ],
        keys: { a: 1, b: 2 },
        messy: { b: 1, a: 2 },
        num: 5,
        str: "hello world",
    },
    null,
    2,
)}\n`;

/** A plain text file, with a character that takes two bytes. */
const NOTES = "alpha\nbéta\n";

/** A .gitignore holding a managed block. */
const IGNORE = "node_modules/\n\n# >>> sous managed: kw (do not edit between these markers)\nx\n# <<< sous managed: kw\n";

beforeEach(() => {
    tmp = makeTmpDir();
    project = editorProject(tmp.path);
    project.write("data.json", DATA);
    project.write("notes.txt", NOTES);
    project.write(".gitignore", IGNORE);
    fs.mkdirSync(path.join(tmp.path, "docs"));
});

afterEach(() => {
    tmp.cleanup();
});

/** One assertion: its file and its `assert` object, without a level. */
interface Assertion {
    readonly file: string;
    readonly assert: JsonObject;
}

/** A check, with an assertion that holds and one that does not. */
interface CheckCase {
    readonly check: string;
    readonly passes: Assertion;
    readonly fails: Assertion;
}

const data = (assert: JsonObject): Assertion => ({ file: "data.json", assert });
const notes = (assert: JsonObject): Assertion => ({ file: "notes.txt", assert });

/** Every check, each with a case that holds and one that does not. */
const CASES: CheckCase[] = [
    { check: "equals", passes: data({ path: "list", equals: ["a", "b", "c"] }), fails: data({ path: "list", equals: ["a"] }) },
    { check: "includes", passes: data({ path: "list", includes: "b" }), fails: data({ path: "list", includes: "z" }) },
    { check: "includes", passes: data({ path: "list", includes: "z", not: true }), fails: data({ path: "list", includes: "b", not: true }) },
    { check: "includes", passes: data({ path: "str", includes: "lo wo" }), fails: data({ path: "str", includes: "bye" }) },
    { check: "includes", passes: data({ path: "keys", includes: { a: 1 } }), fails: data({ path: "keys", includes: { a: 2 } }) },
    { check: "excludes", passes: data({ path: "list", excludes: "z" }), fails: data({ path: "list", excludes: "b" }) },
    { check: "exists", passes: data({ path: "num", exists: true }), fails: data({ path: "nope", exists: true }) },
    { check: "exists", passes: data({ path: "nope", exists: false }), fails: data({ path: "num", exists: false }) },
    { check: "first", passes: data({ path: "list", first: "a" }), fails: data({ path: "list", first: "b" }) },
    { check: "last", passes: data({ path: "list", last: "c" }), fails: data({ path: "list", last: "a" }) },
    { check: "at", passes: data({ path: "list", at: { index: 1, item: "b" } }), fails: data({ path: "list", at: { index: 0, item: "b" } }) },
    { check: "itemWhere", passes: data({ path: "objs", itemWhere: { id: 2 } }), fails: data({ path: "objs", itemWhere: { id: 3 } }) },
    {
        check: "itemWhere",
        passes: data({ path: "objs", itemWhere: { match: { id: 2 }, item: { id: 2, n: "y" } } }),
        fails: data({ path: "objs", itemWhere: { match: { id: 2 }, item: { id: 2, n: "z" } } }),
    },
    { check: "noItemWhere", passes: data({ path: "objs", noItemWhere: { id: 3 } }), fails: data({ path: "objs", noItemWhere: { id: 1 } }) },
    { check: "unique", passes: data({ path: "list", unique: true }), fails: data({ path: "dups", unique: true }) },
    { check: "unique", passes: data({ path: "objs", unique: { by: "n" } }), fails: data({ path: "dups", unique: { by: "n" } }) },
    { check: "sorted", passes: data({ path: "list", sorted: true }), fails: data({ path: "dups", sorted: true }) },
    { check: "sorted", passes: data({ path: "objs", sorted: { by: "id" } }), fails: data({ path: "objs", sorted: { by: "id", descending: true } }) },
    { check: "sortedKeys", passes: data({ path: "keys", sortedKeys: true }), fails: data({ path: "messy", sortedKeys: true }) },
    { check: "type", passes: data({ path: "list", type: "array" }), fails: data({ path: "list", type: "object" }) },
    { check: "type", passes: data({ path: "nope", type: "missing" }), fails: data({ path: "num", type: "string" }) },
    { check: "matches", passes: data({ path: "str", matches: "^hello" }), fails: data({ path: "str", matches: "/^WORLD/i" }) },
    { check: "includesLine", passes: notes({ includesLine: "béta" }), fails: notes({ includesLine: "bet" }) },
    {
        check: "includesBlock",
        passes: { file: ".gitignore", assert: { includesBlock: { name: "kw", content: "x" } } },
        fails: { file: ".gitignore", assert: { includesBlock: { name: "kw", content: "y" } } },
    },
    { check: "includesBlock", passes: { file: ".gitignore", assert: { includesBlock: "kw" } }, fails: { file: ".gitignore", assert: { includesBlock: "other" } } },
    { check: "lessThan", passes: data({ path: "num", lessThan: 6 }), fails: data({ path: "num", lessThan: 5 }) },
    { check: "lessThanOrEqualTo", passes: data({ path: "num", lessThanOrEqualTo: 5 }), fails: data({ path: "num", lessThanOrEqualTo: 4 }) },
    { check: "greaterThan", passes: data({ path: "num", greaterThan: 4 }), fails: data({ path: "num", greaterThan: 5 }) },
    { check: "greaterThanOrEqualTo", passes: data({ path: "num", greaterThanOrEqualTo: 5 }), fails: data({ path: "num", greaterThanOrEqualTo: 6 }) },
    { check: "greaterThan", passes: data({ path: "num", greaterThan: 4 }), fails: data({ path: "str", greaterThan: 0 }) },
    { check: "fileExists", passes: { file: "data.json", assert: { fileExists: true } }, fails: { file: "missing.json", assert: { fileExists: true } } },
    { check: "fileDoesNotExist", passes: { file: "missing.json", assert: { fileDoesNotExist: true } }, fails: { file: "data.json", assert: { fileDoesNotExist: true } } },
    { check: "directoryExists", passes: { file: "docs", assert: { directoryExists: true } }, fails: { file: "nodir", assert: { directoryExists: true } } },
    {
        check: "directoryDoesNotExist",
        passes: { file: "nodir", assert: { directoryDoesNotExist: true } },
        fails: { file: "docs", assert: { directoryDoesNotExist: true } },
    },
    // The text these measure is the file as it is about to be written: NOTES and the line "touched".
    // 20 bytes, 19 characters, a few tokens.
    { check: "maxBytes", passes: notes({ maxBytes: 20 }), fails: notes({ maxBytes: 19 }) },
    { check: "minBytes", passes: notes({ minBytes: 20 }), fails: notes({ minBytes: 21 }) },
    { check: "maxCharacters", passes: notes({ maxCharacters: 19 }), fails: notes({ maxCharacters: 18 }) },
    { check: "minCharacters", passes: notes({ minCharacters: 19 }), fails: notes({ minCharacters: 20 }) },
    { check: "maxTokens", passes: notes({ maxTokens: 1000 }), fails: notes({ maxTokens: 1 }) },
    { check: "minTokens", passes: notes({ minTokens: 1 }), fails: notes({ minTokens: 1000 }) },
];

/** The checks about the file or folder itself: the file is not edited alongside them. */
const EXISTENCE = new Set(["fileExists", "fileDoesNotExist", "directoryExists", "directoryDoesNotExist"]);

/** An edit to the asserted file, so a test can see whether the file was written. */
function touch(file: string): JsonObject {
    return file.endsWith(".json") ? { file, set: { path: "touched", value: true } } : { file, ensureLine: { line: "touched" } };
}

async function run(assertion: Assertion, level: "error" | "warn") {
    const check = Object.keys(assertion.assert).find((key) => CHECKS.has(key))!;
    const edits = EXISTENCE.has(check) ? [] : [touch(assertion.file)];
    const before = project.read(assertion.file);
    const assert = level === "warn" ? { ...assertion.assert, level: "warn", message: "Why it matters." } : assertion.assert;
    const outcome = await project.apply([...edits, { file: assertion.file, assert }]);
    const authored = outcome.result.assertions.filter((item) => !item.automatic);

    return { ...outcome, authored, before, after: project.read(assertion.file), edited: edits.length > 0 };
}

describe("every check through editor.apply", () => {
    for (const { check, passes, fails } of CASES) {
        const name = `${check} ${JSON.stringify(passes.assert)}`;

        /**
         * An assertion that holds, at level error and at level warn: the result is ok, nothing is
         * reported, and the edit beside it is written.
         *
         * assert { path: "list", includes: "b" } on ["a", "b", "c"] -> passed; the file is written
         */
        it(`should pass ${name} at level error and at level warn`, async () => {
            for (const level of ["error", "warn"] as const) {
                const { result, authored, warnings, errors, before, after, edited } = await run(passes, level);

                expect(authored.map((item) => [item.check, item.passed, item.level])).toEqual([[check, true, level]]);
                expect(result.ok).toBe(true);
                expect(warnings).toEqual([]);
                expect(errors).toEqual([]);

                if (edited) expect(after).not.toBe(before);

                await project.apply([]);
            }
        });

        /**
         * An assertion that does not hold. At level error the file is not written, the result is
         * not ok, and the failure is reported as an error; at level warn the file is written, the
         * result is ok, and the failure, with its message, is a warning.
         *
         * assert { path: "list", includes: "z" } -> error: not written; level warn: written, warned
         */
        it(`should fail ${JSON.stringify(fails.assert)} as an error, and as a warning at level warn`, async () => {
            const failed = await run(fails, "error");

            expect(failed.authored.map((item) => [item.check, item.passed, item.level])).toEqual([[check, false, "error"]]);
            expect(failed.result.ok).toBe(false);
            expect(failed.after).toBe(failed.before);
            expect(failed.result.files.find((file) => file.file === fails.file)?.action).toBe("not-written");
            expect(failed.errors).toHaveLength(1);
            expect(failed.errors[0]).toContain(`Assertion failed in ${fails.file}`);
            expect(failed.errors[0]).toContain("test-declarer expects");
            expect(failed.warnings).toEqual([]);

            const warned = await run(fails, "warn");

            expect(warned.authored.map((item) => [item.check, item.passed, item.level])).toEqual([[check, false, "warn"]]);
            expect(warned.result.ok).toBe(true);
            expect(warned.errors).toEqual([]);
            expect(warned.warnings).toHaveLength(1);
            expect(warned.warnings[0]).toContain(`Assertion failed in ${fails.file}`);
            expect(warned.warnings[0]).toContain("Why it matters.");

            if (warned.edited) expect(warned.after).not.toBe(warned.before);
        });
    }

    /**
     * Every check the package defines has a case above.
     *
     * [...CHECKS.keys()] -> each found in the cases
     */
    it("should cover every check", () => {
        const covered = new Set(CASES.map((testCase) => testCase.check));

        expect([...CHECKS.keys()].filter((check) => !covered.has(check))).toEqual([]);
    });

    /**
     * `--ignore-failed-assertions` prints a failure at level error as a warning, writes the file,
     * and the result is ok.
     *
     * assert { includes: "z" } with ignoreFailedAssertions -> ok, warning, written
     */
    it("should write the file and warn when failed assertions are ignored", async () => {
        const { result, warnings, errors } = await project.apply([touch("data.json"), { file: "data.json", assert: { path: "list", includes: "z" } }], {
            ignoreFailedAssertions: true,
        });

        expect(result.ok).toBe(true);
        expect(errors).toEqual([]);
        expect(warnings[0]).toContain("Assertion failed in data.json at list");
        expect(JSON.parse(project.read("data.json")!).touched).toBe(true);
    });

    /**
     * One `assert` holding several checks makes one assertion per check, each with its own
     * outcome.
     *
     * assert { path: "list", includes: "a", first: "b", level: warn } -> includes passed, first failed
     */
    it("should run each check of one assert on its own", async () => {
        const { result, warnings } = await project.apply([{ file: "data.json", assert: { path: "list", includes: "a", first: "b", level: "warn" } }]);

        expect(result.assertions.map((item) => [item.check, item.passed])).toEqual([
            ["includes", true],
            ["first", false],
        ]);
        expect(warnings).toHaveLength(1);
    });
});
