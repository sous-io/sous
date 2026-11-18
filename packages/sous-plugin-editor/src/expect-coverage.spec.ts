import { afterEach, beforeEach, describe, expect as check, it } from "vitest";
import type { ConfigBuilder } from "@sous-io/sous-plugin-api";
import { editorProject, type EditorProject } from "../test/engine.js";
import { makeTmpDir } from "../test/helpers.js";
import { editor, expect } from "./chain.js";

let tmp: { path: string; cleanup(): void };
let project: EditorProject;

const SETTINGS = `${JSON.stringify(
    {
        permissions: { allow: ["Bash(acme-commit.sh:*)", "Read"], deny: ["Bash(rm:*)"] },
        env: { ACME_COMMS_DIR: "/work/comms", LEVEL: 3 },
        repos: [{ repo: "local", rev: "1" }],
    },
    null,
    2,
)}\n`;

/** 26 bytes, 25 characters (one takes two bytes). */
const OVERRIDE = "# Override\n\nUse the café.\n";

beforeEach(() => {
    tmp = makeTmpDir();
    project = editorProject(tmp.path);
    project.write(".claude/settings.json", SETTINGS);
    project.write("AGENTS.override.md", OVERRIDE);
    project.write(".gitignore", "node_modules/\n");
});

afterEach(() => {
    tmp.cleanup();
});

/** Each authored assertion's outcome, as `[check, path, passed, level]`. */
function outcomes(result: { assertions: Array<{ check: string; path: string; passed: boolean; level: string; automatic: boolean }> }) {
    return result.assertions.filter((item) => !item.automatic).map((item) => [item.check, item.path, item.passed, item.level]);
}

describe("expect(...) through editor.apply", () => {
    /**
     * Every form spec 08 shows records the `assert` entry it stands for, and `editor.apply` runs
     * it: these all hold, so the result is ok and nothing is reported.
     *
     * expect( settings.at("permissions.allow") ).to.include("Bash(acme-commit.sh:*)");
     * // -> { file, assert: { path: "permissions.allow", includes: "Bash(acme-commit.sh:*)" } }
     */
    it("should record each form of spec 08 as its entry, and run it", async () => {
        const contribute = (config: ConfigBuilder) => {
            const settings = editor(config).file(".claude/settings.json");
            const overrideFile = editor(config).file("AGENTS.override.md");
            const memoriesFile = editor(config).file("AGENTS.override.md");
            const oldPluginManifest = editor(config).file("old/plugin.json");

            expect( settings.at("permissions.allow") ).to.include("Bash(acme-commit.sh:*)");
            expect( settings.at("permissions.deny") ).to.not.include("Bash(acme-commit.sh:*)");
            expect( settings.at("permissions.allow") ).to.be.an("array").that.is.sorted();
            expect( settings.at("permissions.allow") ).to.have.unique.members();
            expect( settings.at("permissions.allow") ).to.have.first.member("Bash(acme-commit.sh:*)");
            expect( settings.at("env.ACME_COMMS_DIR") )
                .to.match(/^\$\{projectRoot\}|^\//)
                .orWarn()
                .withMessage("The comms folder must be inside the project.");
            expect( overrideFile.byteCount ).to.be.lessThan(32768).orWarn().withMessage("Codex cuts project instructions off at 32 KiB.");
            expect( memoriesFile.tokenCount ).to.be.lessThanOrEqualTo(20000);
            expect( oldPluginManifest ).to.not.exist();
            expect( memoriesFile.byteCount )
                .to.be.lessThanOrEqualTo(32 * 1024)
                .orWarn()
                .withMessage("Codex cuts a project's instructions off at 32 KiB. The end of this file will not be read.");
            expect( overrideFile.characterCount ).to.be.greaterThan(24);
        };
        const { result, edits, warnings, errors } = await project.apply(contribute);

        check(edits).toEqual([
            { file: ".claude/settings.json", assert: { path: "permissions.allow", includes: "Bash(acme-commit.sh:*)" } },
            { file: ".claude/settings.json", assert: { path: "permissions.deny", includes: "Bash(acme-commit.sh:*)", not: true } },
            { file: ".claude/settings.json", assert: { path: "permissions.allow", type: "array" } },
            { file: ".claude/settings.json", assert: { path: "permissions.allow", sorted: true } },
            { file: ".claude/settings.json", assert: { path: "permissions.allow", unique: true } },
            { file: ".claude/settings.json", assert: { path: "permissions.allow", first: "Bash(acme-commit.sh:*)" } },
            {
                file: ".claude/settings.json",
                assert: { path: "env.ACME_COMMS_DIR", matches: "/^\\$\\{projectRoot\\}|^\\//", level: "warn", message: "The comms folder must be inside the project." },
            },
            { file: "AGENTS.override.md", assert: { maxBytes: 32767, level: "warn", message: "Codex cuts project instructions off at 32 KiB." } },
            { file: "AGENTS.override.md", assert: { maxTokens: 20000 } },
            { file: "old/plugin.json", assert: { fileDoesNotExist: true } },
            {
                file: "AGENTS.override.md",
                assert: { maxBytes: 32768, level: "warn", message: "Codex cuts a project's instructions off at 32 KiB. The end of this file will not be read." },
            },
            { file: "AGENTS.override.md", assert: { minCharacters: 25 } },
        ]);
        check(result.ok).toBe(true);
        check(warnings).toEqual([]);
        check(errors).toEqual([]);
        check(outcomes(result)).toEqual([
            ["includes", "permissions.allow", true, "error"],
            ["includes", "permissions.deny", true, "error"],
            ["type", "permissions.allow", true, "error"],
            ["sorted", "permissions.allow", true, "error"],
            ["unique", "permissions.allow", true, "error"],
            ["first", "permissions.allow", true, "error"],
            ["matches", "env.ACME_COMMS_DIR", true, "warn"],
            ["maxBytes", "", true, "warn"],
            ["maxTokens", "", true, "error"],
            ["maxBytes", "", true, "warn"],
            ["minCharacters", "", true, "error"],
            ["fileDoesNotExist", "", true, "error"],
        ]);
    });

    /**
     * The same forms where they do not hold: one at level error fails the build and its file is
     * not written; one lowered with `.orWarn()` is a warning carrying its `.withMessage(...)`.
     *
     * expect( file.byteCount ).to.be.lessThanOrEqualTo(10).orWarn().withMessage("Too big.");
     * // -> { assert: { maxBytes: 10, level: "warn", message: "Too big." } }: a warning
     */
    it("should fail at level error, and warn with the message after orWarn", async () => {
        const { result, edits, warnings, errors } = await project.apply((config) => {
            const settings = editor(config).file(".claude/settings.json");
            const override = editor(config).file("AGENTS.override.md");

            override.ensureLine("touched");
            expect( override.byteCount ).to.be.lessThanOrEqualTo(10).orWarn().withMessage("Too big.");
            expect( override.characterCount ).to.be.lessThan(5).orWarn();
            expect( override.tokenCount ).to.be.greaterThanOrEqualTo(100000).orWarn();
            settings.at("env.MODE").set("strict");
            expect( settings.at("permissions.allow") ).to.include("Write").withMessage("The harness needs Write.");
        });

        check(edits.slice(1, 4)).toEqual([
            { file: "AGENTS.override.md", assert: { maxBytes: 10, level: "warn", message: "Too big." } },
            { file: "AGENTS.override.md", assert: { maxCharacters: 4, level: "warn" } },
            { file: "AGENTS.override.md", assert: { minTokens: 100000, level: "warn" } },
        ]);
        check(result.ok).toBe(false);
        check(outcomes(result)).toEqual([
            ["maxBytes", "", false, "warn"],
            ["maxCharacters", "", false, "warn"],
            ["minTokens", "", false, "warn"],
            ["includes", "permissions.allow", false, "error"],
        ]);
        check(warnings).toHaveLength(3);
        check(warnings[0]).toContain("Too big.");
        check(errors).toHaveLength(1);
        check(errors[0]).toContain('test-declarer expects it to include "Write".');
        check(errors[0]).toContain("The harness needs Write.");
        check(project.read(".claude/settings.json")).toBe(SETTINGS);
        check(project.read("AGENTS.override.md")).toBe(`${OVERRIDE}touched\n`);
    });

    /**
     * The other spellings of the chain record the checks they stand for: `.equal`, `.exist`,
     * `.last.member`, `.itemWhere` (and `.not.itemWhere`), `.line`, `.sortedKeys`, a value's
     * comparisons, and Chai's `at.most` and `at.least`; and each runs.
     *
     * expect( settings.at("env.LEVEL") ).to.be.at.most(3);   // -> { lessThanOrEqualTo: 3 }
     */
    it("should record and run the other spellings", async () => {
        const { result, edits, warnings, errors } = await project.apply((config) => {
            const settings = editor(config).file(".claude/settings.json");
            const ignore = editor(config).file(".gitignore");

            expect( settings.at("env.LEVEL") ).to.equal(3);
            expect( settings.at("env") ).to.exist();
            expect( settings ).to.exist();
            expect( settings.at("permissions.allow") ).to.have.last.member("Read");
            expect( settings.at("repos") ).to.have.itemWhere({ repo: "local" });
            expect( settings.at("repos") ).to.have.itemWhere({ repo: "local" }, { repo: "local", rev: "1" });
            expect( settings.at("repos") ).to.not.have.itemWhere({ repo: "remote" });
            expect( ignore ).to.have.line("node_modules/");
            expect( settings.at("env") ).to.have.sortedKeys();
            expect( settings.at("env.LEVEL") ).to.be.greaterThan(2);
            expect( settings.at("env.LEVEL") ).to.be.lessThan(4);
            expect( settings.at("env.LEVEL") ).to.be.at.most(3);
            expect( settings.at("env.LEVEL") ).to.be.at.least(3);
        });

        check(edits.map((entry) => (entry as { assert: object }).assert)).toEqual([
            { path: "env.LEVEL", equals: 3 },
            { path: "env", exists: true },
            { fileExists: true },
            { path: "permissions.allow", last: "Read" },
            { path: "repos", itemWhere: { repo: "local" } },
            { path: "repos", itemWhere: { match: { repo: "local" }, item: { repo: "local", rev: "1" } } },
            { path: "repos", noItemWhere: { repo: "remote" } },
            { includesLine: "node_modules/" },
            { path: "env", sortedKeys: true },
            { path: "env.LEVEL", greaterThan: 2 },
            { path: "env.LEVEL", lessThan: 4 },
            { path: "env.LEVEL", lessThanOrEqualTo: 3 },
            { path: "env.LEVEL", greaterThanOrEqualTo: 3 },
        ]);
        check(result.ok).toBe(true);
        check(warnings).toEqual([]);
        check(errors).toEqual([]);
        check(result.assertions.every((item) => item.passed)).toBe(true);
        check(result.assertions).toHaveLength(13);
    });
});
