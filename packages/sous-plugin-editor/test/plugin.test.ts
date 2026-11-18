import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect as check, it } from "vitest";
import { BufferedReporter, definePlugin, jsonSchema, type ConfigBuilder, type PluginDefinition } from "@sous-io/sous-plugin-api";
import { createEngine } from "@sous-io/sous-lib-core";
import { doctorPlugin } from "@sous-io/sous-plugin-doctor";
import editorPlugin, { editor, expect } from "../src/index.js";
import type { EditorApplyResult } from "../src/types.js";
import { makeTmpDir, read, write } from "./helpers.js";

let tmp: { path: string; cleanup(): void };

beforeEach(() => {
    tmp = makeTmpDir();
});

afterEach(() => {
    tmp.cleanup();
});

/** Stands in for sous-plugin-compiler and sous-plugin-variables, which the editor depends on. */
const standIns = (["@sous-io/sous-plugin-compiler", "@sous-io/sous-plugin-variables"] as const).map((name) =>
    definePlugin({ name, version: editorPlugin.version, register() {} }),
);

/** A plugin with one contributor. */
function plugin(name: string, contribute: (config: ConfigBuilder) => void): PluginDefinition {
    return definePlugin({
        name,
        version: "1.0.0",
        register(sous) {
            sous.config.contribute({ id: `${name}/edits`, contribute });
        },
    });
}

/** A plugin that runs `editor.apply`, as the build will. */
const runner = definePlugin({
    name: "test-runner",
    version: "1.0.0",
    register(sous) {
        sous.intents.add({
            intent: "test.apply",
            input: jsonSchema({ type: "object" }),
            handle: async (input, ctx) => (await ctx.run("editor.apply", input as Record<string, unknown>)) as never,
        });
    },
});

function makeEngine(...plugins: PluginDefinition[]) {
    const reporter = new BufferedReporter();
    const sousDir = path.join(tmp.path, ".sous");

    fs.mkdirSync(sousDir, { recursive: true });

    const engine = createEngine({
        builtIns: [...standIns, doctorPlugin, editorPlugin, runner, ...plugins],
        reporter,
        project: { root: tmp.path, sousDir, configPath: undefined, confDir: path.join(sousDir, "conf.d") },
        cwd: tmp.path,
    });

    return { engine, reporter };
}

describe("the chain and expect", () => {
    /**
     * Each chain call records one entry in editor.edits, in the one entry shape; expect records an
     * `assert` entry; orWarn and withMessage change it. The chain reads no file.
     *
     * editor(config).file("s.json").at("permissions.allow").appendIfMissing("a").dedupe().sort();
     * // -> three entries, each { file, <operation>: { path, ... } }
     */
    it("should record entries in editor.edits", async () => {
        const { engine } = makeEngine(
            plugin("sous-plugin-acme", (config) => {
                const settings = editor(config).file("${projectRoot}/.claude/settings.json");

                settings.at("env.ACME_COMMS_DIR").set("${projectRoot}/comms");
                settings.at("permissions.allow").appendIfMissing("Bash(acme-commit.sh:*)").dedupe().sort().withoutAssertion();

                expect(settings.at("permissions.allow")).to.include("Bash(acme-commit.sh:*)");
                expect(settings.at("permissions.allow")).to.be.an("array").that.is.sorted();
                expect(settings.at("permissions.allow")).to.have.unique.members();
                expect(settings.at("permissions.allow")).to.have.first.member("x");
                expect(settings.at("permissions.deny")).to.not.include("y");
                expect(settings.byteCount).to.be.lessThan(32768).orWarn().withMessage("Too big.");
                expect(settings.tokenCount).to.be.lessThanOrEqualTo(20000);
                expect(editor(config).file("old.json")).to.not.exist();

                settings.silence("permissions", ["sorted", "unique"]).thisKeyOnly();
                settings.silence("permissions.allow").except(["include"]);
                editor(config).file("other.json").withoutAutomaticAssertions();
                editor(config).ensureDirectoryExists(["docs/context"]);
            }),
        );
        const built = await engine.buildConfig();

        check(built.get("editor.edits")).toEqual([
            { file: "${projectRoot}/.claude/settings.json", set: { path: "env.ACME_COMMS_DIR", value: "${projectRoot}/comms" } },
            { file: "${projectRoot}/.claude/settings.json", appendIfMissing: { path: "permissions.allow", items: "Bash(acme-commit.sh:*)" } },
            { file: "${projectRoot}/.claude/settings.json", dedupe: { path: "permissions.allow" } },
            { file: "${projectRoot}/.claude/settings.json", sort: { path: "permissions.allow", assertion: "none" } },
            { file: "${projectRoot}/.claude/settings.json", assert: { path: "permissions.allow", includes: "Bash(acme-commit.sh:*)" } },
            { file: "${projectRoot}/.claude/settings.json", assert: { path: "permissions.allow", type: "array" } },
            { file: "${projectRoot}/.claude/settings.json", assert: { path: "permissions.allow", sorted: true } },
            { file: "${projectRoot}/.claude/settings.json", assert: { path: "permissions.allow", unique: true } },
            { file: "${projectRoot}/.claude/settings.json", assert: { path: "permissions.allow", first: "x" } },
            { file: "${projectRoot}/.claude/settings.json", assert: { path: "permissions.deny", includes: "y", not: true } },
            { file: "${projectRoot}/.claude/settings.json", assert: { maxBytes: 32767, level: "warn", message: "Too big." } },
            { file: "${projectRoot}/.claude/settings.json", assert: { maxTokens: 20000 } },
            { file: "old.json", assert: { fileDoesNotExist: true } },
            { file: "${projectRoot}/.claude/settings.json", silence: { path: "permissions", kinds: ["sorted", "unique"], scope: "key-only" } },
            { file: "${projectRoot}/.claude/settings.json", silence: { path: "permissions.allow", except: ["include"] } },
            { file: "other.json", silence: {} },
            { ensureDirectoryExists: { paths: ["docs/context"] } },
        ]);
    });

    /**
     * A misspelt operation in editor.edits is a config error naming it.
     */
    it("should refuse an entry with an unknown operation when the config is built", async () => {
        const { engine } = makeEngine(
            plugin("sous-plugin-typo", (config) => {
                config.atPath("editor.edits").appendValue({ file: "a.json", sett: { path: "a", value: 1 } });
            }),
        );

        const error = await engine.buildConfig().then(
            () => undefined,
            (failure: unknown) => failure as { details?: unknown },
        );

        check(JSON.stringify(error?.details)).toMatch(/'sett' is not an operation/);
    });
});

describe("editor.apply", () => {
    /**
     * The intent reads editor.edits from the finished config, names each entry's declarer (the
     * plugin, here), applies the edits and keeps the history; when the plugin stops declaring
     * them, it undoes them.
     */
    it("should apply what plugins declared, name them, and undo when they stop", async () => {
        write(tmp.path, ".claude/settings.json", '{\n    // mine\n    "permissions": { "allow": ["x"] }\n}\n');

        let declare = true;
        const { engine } = makeEngine(
            plugin("sous-plugin-acme", (config) => {
                if (!declare) return;

                const settings = editor(config).file(".claude/settings.json");

                settings.at("permissions.allow").ensureIncludes(["b", "a"]).sort();
                config.atPath("editor.edits").appendValue({
                    file: ".claude/settings.json",
                    set: { path: "env.MODE", value: "strict" },
                });
            }),
        );

        await engine.buildConfig();

        const result = (await engine.submit({ intent: "test.apply", input: {} })).toPlain() as unknown as EditorApplyResult;

        check(result.ok).toBe(true);
        check(read(tmp.path, ".claude/settings.json")).toContain("// mine");
        check(JSON.parse(read(tmp.path, ".sous/sous.edits.json")!).entries.map((entry: { declarer: string }) => entry.declarer)).toEqual([
            "sous-plugin-acme",
            "sous-plugin-acme",
            "sous-plugin-acme",
        ]);

        const text = read(tmp.path, ".claude/settings.json")!;

        check(text).toMatch(/"a",\s*"b",\s*"x"/);
        check(text).toContain('"MODE": "strict"');

        declare = false;
        await engine.buildConfig();
        await engine.submit({ intent: "test.apply", input: {} });

        check(read(tmp.path, ".claude/settings.json")).not.toContain("MODE");
        check(read(tmp.path, ".claude/settings.json")).toMatch(/"allow": \[\s*"x"\s*\]/);
    });

    /**
     * A project set up before the editor existed has no history line in `.sous/.gitignore`'s
     * managed block: the first run that applies an edit adds it and `backups/`; a dry run, and a
     * project that declares no edit and has no history, gain nothing.
     *
     * editor.apply with one entry -> host.gitignore.add(".sous/.gitignore", ["sous.edits.json", "backups/"])
     */
    it("should add the history file and backups/ to .sous/.gitignore once the editor writes", async () => {
        const added: Array<{ file: string; lines: readonly string[] }> = [];
        const host = definePlugin({
            name: "test-host",
            version: "1.0.0",
            register(sous) {
                sous.services.add("host.gitignore", () => ({ add: async (file: string, lines: readonly string[]) => void added.push({ file, lines }) }) as never, {
                    lifetime: "singleton",
                });
            },
        });
        let declare = false;
        const { engine } = makeEngine(
            host,
            plugin("sous-plugin-lines", (config) => {
                if (declare) config.atPath("editor.edits").appendValue({ file: "a.json", set: { path: "a", value: 1 } });
            }),
        );

        await engine.buildConfig();
        await engine.submit({ intent: "test.apply", input: {} });
        check(added).toEqual([]);
        // Nor does it gain a history file, which would be a new file in .sous/ that git does not ignore.
        check(fs.existsSync(path.join(tmp.path, ".sous", "sous.edits.json"))).toBe(false);

        declare = true;
        await engine.buildConfig();
        await engine.submit({ intent: "test.apply", input: { dryRun: true } });
        check(added).toEqual([]);

        await engine.submit({ intent: "test.apply", input: {} });
        check(added).toEqual([{ file: path.join(tmp.path, ".sous", ".gitignore"), lines: ["sous.edits.json", "backups/"] }]);
    });

    /**
     * A YAML file, a Markdown file's frontmatter and a .gitignore are each edited through the
     * document library: the edit changes only what it names, every other byte stays (comments,
     * the Markdown body, a CRLF line), and undoing puts each file back byte for byte.
     *
     * .pre-commit-config.yaml   set default_stages: [pre-commit]
     * .claude/agents/review.md  set model: opus (frontmatter)
     * .gitignore                ensureLine "dist/", ensureBlock "kw"
     */
    it("should edit YAML, frontmatter and a .gitignore through the library, keeping untouched bytes", async () => {
        const yaml = "# hooks for this repo\nrepos:\n  - repo: local   # ours\n    hooks: []\n";
        const markdown = "---\nname: review\nmodel: sonnet # cheap\n---\n# Review\n\nKeep  this   body\r\nexactly.\n";
        const ignore = "node_modules/\r\n# local files\n.env.local";

        write(tmp.path, ".pre-commit-config.yaml", yaml);
        write(tmp.path, ".claude/agents/review.md", markdown);
        write(tmp.path, ".gitignore", ignore);

        let declare = true;
        const { engine } = makeEngine(
            plugin("sous-plugin-formats", (config) => {
                if (!declare) return;

                config.atPath("editor.edits").appendValue({ file: ".pre-commit-config.yaml", set: { path: "default_stages", value: ["pre-commit"] } });
                config.atPath("editor.edits").appendValue({ file: ".claude/agents/review.md", set: { path: "model", value: "opus" } });
                config.atPath("editor.edits").appendValue({
                    file: ".gitignore",
                    ensureLine: { line: "dist/", position: { after: "node_modules/" } },
                    ensureBlock: { name: "kw", content: "docs/context/.kw-session-*" },
                });
            }),
        );

        await engine.buildConfig();

        const result = (await engine.submit({ intent: "test.apply", input: {} })).toPlain() as unknown as EditorApplyResult;

        check(result.ok).toBe(true);
        check(read(tmp.path, ".pre-commit-config.yaml")).toBe(`${yaml}default_stages:\n  - pre-commit\n`);
        check(read(tmp.path, ".claude/agents/review.md")).toBe("---\nname: review\nmodel: opus # cheap\n---\n# Review\n\nKeep  this   body\r\nexactly.\n");
        check(read(tmp.path, ".gitignore")).toBe(
            [
                "node_modules/\r\n",
                "dist/\r\n",
                "# local files\n",
                ".env.local\r\n",
                "\r\n",
                "# >>> sous managed: kw (do not edit between these markers)\r\n",
                "docs/context/.kw-session-*\r\n",
                "# <<< sous managed: kw",
            ].join(""),
        );

        // A second run changes nothing.
        const again = (await engine.submit({ intent: "test.apply", input: {} })).toPlain() as unknown as EditorApplyResult;

        check(again.files.every((file) => file.action === "unchanged")).toBe(true);

        declare = false;
        await engine.buildConfig();
        await engine.submit({ intent: "test.apply", input: {} });

        check(read(tmp.path, ".pre-commit-config.yaml")).toBe(yaml);
        check(read(tmp.path, ".claude/agents/review.md")).toBe(markdown);
        check(read(tmp.path, ".gitignore")).toBe(ignore);
    });
});

describe("the assertions doctor check", () => {
    /**
     * `sous doctor --only assertions` works out the edits and checks every assertion without
     * writing: a failed assertion at level error is a problem, and the files stay as they were.
     *
     * assert a.json includes "x" (it does not) -> problem; a.json unchanged
     */
    it("should report a failing assertion as a problem without writing anything", async () => {
        write(tmp.path, "a.json", '{ "list": [] }\n');

        let holds = false;
        const { engine } = makeEngine(
            plugin("sous-plugin-asserts", (config) => {
                config.atPath("editor.edits").appendValue({ file: "a.json", set: { path: "other", value: 1 } });
                config.atPath("editor.edits").appendValue({ file: "a.json", assert: { path: "list", includes: "x", message: "x must be listed." } });

                if (holds) config.atPath("editor.edits").appendValue({ file: "a.json", ensureIncludes: { path: "list", items: ["x"] } });
            }),
        );

        await engine.buildConfig();

        const report = (await engine.submit({ intent: "doctor", input: { only: ["assertions"], dryRun: true } })).toPlain() as unknown as {
            checks: Array<{ id: string; found: { status: string; details?: string[] } }>;
        };

        check(report.checks).toHaveLength(1);
        check(report.checks[0]!.found.status).toBe("problem");
        check(report.checks[0]!.found.details?.[0]).toContain("a.json");
        check(read(tmp.path, "a.json")).toBe('{ "list": [] }\n');
        check(fs.existsSync(path.join(tmp.path, ".sous", "sous.edits.json"))).toBe(false);

        holds = true;
        await engine.buildConfig();

        const fixed = (await engine.submit({ intent: "doctor", input: { only: ["assertions"], dryRun: true } })).toPlain() as unknown as {
            checks: Array<{ found: { status: string } }>;
        };

        check(fixed.checks[0]!.found.status).toBe("ok");
        check(read(tmp.path, "a.json")).toBe('{ "list": [] }\n');
    });
});
