import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect as check, it } from "vitest";
import { BufferedReporter, definePlugin, jsonSchema, type ConfigBuilder, type PluginDefinition } from "@sous-io/plugin-api";
import { createEngine } from "@sous-io/core";
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

/** Stands in for plugin-compiler and plugin-variables, which the editor depends on. */
const standIns = (["@sous-io/plugin-compiler", "@sous-io/plugin-variables"] as const).map((name) =>
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
        builtIns: [...standIns, editorPlugin, runner, ...plugins],
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
});
