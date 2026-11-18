import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine } from "@sous-io/core";
import { BufferedReporter, definePlugin, IntentOutputs, jsonSchema, type PluginDefinition } from "@sous-io/sous-plugin-api";
import type { HostProcesses } from "@sous-io/sous-plugin-host/types";
import harnessesPlugin from "@sous-io/sous-plugin-harnesses";
import codexPlugin from "../src/index.js";
import packageJson from "../package.json" with { type: "json" };

const dirs: string[] = [];

function tmp(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sous-codex-"));

    dirs.push(dir);

    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Every interactive run, by command and arguments. */
const launched: Array<{ command: string; args: readonly string[]; cwd: string | undefined }> = [];

/** A stand-in for `host.processes` that records interactive runs and starts nothing. */
const processes: HostProcesses = {
    run: () => {
        throw new Error("not used");
    },
    runSync: () => {
        throw new Error("not used");
    },
    runInteractive: async (command, args, options = {}) => {
        launched.push({ command, args, cwd: options.cwd });

        return { exitCode: 0, signal: null, durationMs: 0 };
    },
    which: async () => undefined,
};

afterEach(() => {
    launched.splice(0);
});

const stubs: PluginDefinition[] = [
    definePlugin({
        name: "@sous-io/sous-plugin-host",
        version: packageJson.version,
        register: (sous) => sous.services.add("host.processes", () => processes, { lifetime: "singleton" }),
    }),
    definePlugin({
        name: "@sous-io/sous-plugin-build",
        version: packageJson.version,
        register: (sous) => sous.intents.add({ intent: "build", handle: () => IntentOutputs.of({ ok: true }) as never }),
    }),
    // The kinds sous-plugin-skills and sous-plugin-memories own.
    definePlugin({
        name: "@sous-io/sous-plugin-skills",
        version: packageJson.version,
        register: (sous) => sous.entities.define("skill-target", jsonSchema({ type: "object", required: ["id", "directory"] })),
    }),
    definePlugin({
        name: "@sous-io/sous-plugin-memories",
        version: packageJson.version,
        register: (sous) => sous.entities.define("memory-target", jsonSchema({ type: "object", required: ["id", "outputPath"] })),
    }),
];

/** A stand-in for the editor plugin: only its config key, which is what this plugin looks for. */
const editorStub = definePlugin({
    name: "@sous-io/sous-plugin-editor",
    version: packageJson.version,
    register: (sous) => sous.entities.add("config-key", { id: "editor", schema: jsonSchema({ type: "object" }) }),
});

function config(values: Record<string, unknown>): PluginDefinition {
    return definePlugin({
        name: "test-config",
        version: "1.0.0",
        register: (sous) => sous.config.contribute({ id: "test-config", contribute: (c) => c.root().merge(values as never) }),
    });
}

async function engineFor(root: string, values: Record<string, unknown> = {}, extra: PluginDefinition[] = []) {
    const engine = createEngine({
        builtIns: [...stubs, ...extra, harnessesPlugin, codexPlugin, config(values)],
        reporter: new BufferedReporter(),
        project: { root, sousDir: path.join(root, ".sous"), configPath: undefined, confDir: path.join(root, ".sous", "conf.d") },
    });

    return { engine, config: await engine.buildConfig() };
}

/** The config that turns Codex on with this plugin's options. */
const on = (options: Record<string, unknown> = {}) => ({ plugins: { options: { "@sous-io/sous-plugin-codex": options } } });

describe("when Codex is on", () => {
    it("is off in a project that names Codex nowhere: no harness, no targets, no extra build", async () => {
        const { config: built } = await engineFor(tmp());

        expect(built.entities.get("harness", "codex")).toBeUndefined();
        expect(built.entities.get("skill-target", "codex")).toBeUndefined();
        expect(built.entities.get("memory-target", "codex")).toBeUndefined();
        expect(built.harnesses).toEqual([]);
    });

    it("is on when the project writes the plugin's options, even as {}", async () => {
        const { config: built } = await engineFor(tmp(), on());

        expect(built.entities.get("harness", "codex")).toMatchObject({ id: "codex" });
        expect(built.harnesses).toEqual(["codex"]);
    });

    it("is on when the project writes tools.codex, with this plugin's harness rather than a generic tool", async () => {
        const { config: built } = await engineFor(tmp(), { tools: { codex: { args: ["--full-auto"] } } });

        expect(built.entities.describe("harness").map((r) => [r.id, r.plugin])).toEqual([["codex", "@sous-io/sous-plugin-codex"]]);
        expect(built.entities.get("memory-target", "codex")).toBeDefined();
    });
});

describe("entities", () => {
    it("adds the memory target: AGENTS.override.md at the root, AGENTS.md before it, backed up, for the codex harness", async () => {
        const { config: built } = await engineFor(tmp(), on());

        expect(built.entities.get("memory-target", "codex")).toEqual({
            id: "codex",
            harness: "codex",
            outputPath: "${projectRoot}/AGENTS.override.md",
            prependWith: "${projectRoot}/AGENTS.md",
            backupExisting: true,
        });
    });

    it("adds the skill target .agents/skills for the codex harness", async () => {
        const { config: built } = await engineFor(tmp(), on());

        expect(built.entities.get("skill-target", "codex")).toMatchObject({ harness: "codex", directory: ".agents/skills" });
    });

    it("lets the options move the memories file, change what comes before it and move the skills", async () => {
        const { config: built } = await engineFor(
            tmp(),
            on({ memoriesOutputPath: "docs/CODEX.md", prependMemoriesWith: "${projectRoot}/docs/AGENTS.md", skillsDirectory: "tools/skills" }),
        );

        expect(built.entities.get("memory-target", "codex")).toMatchObject({
            outputPath: "${projectRoot}/docs/CODEX.md",
            prependWith: "${projectRoot}/docs/AGENTS.md",
        });
        expect(built.entities.get("skill-target", "codex")?.directory).toBe("tools/skills");
    });

    it("adds no memory target when memories is false, and keeps the harness and skills", async () => {
        const { config: built } = await engineFor(tmp(), on({ memories: false }));

        expect(built.entities.get("memory-target", "codex")).toBeUndefined();
        expect(built.entities.get("skill-target", "codex")).toBeDefined();
        expect(built.entities.get("harness", "codex")).toBeDefined();
    });
});

describe("the .gitignore line", () => {
    it("declares an edit that keeps the memories file out of git, when the editor is loaded", async () => {
        const { config: built } = await engineFor(tmp(), on(), [editorStub]);

        expect(built.get("editor.edits")).toEqual([{ file: ".gitignore", ensureLine: { line: "/AGENTS.override.md" } }]);
    });

    it("follows a moved memories file", async () => {
        const { config: built } = await engineFor(tmp(), on({ memoriesOutputPath: "docs/CODEX.md" }), [editorStub]);

        expect(built.get("editor.edits")).toEqual([{ file: ".gitignore", ensureLine: { line: "/docs/CODEX.md" } }]);
    });

    it("declares nothing when Codex is off, when memories are off, or without the editor", async () => {
        expect((await engineFor(tmp(), {}, [editorStub])).config.get("editor.edits")).toBeUndefined();
        expect((await engineFor(tmp(), on({ memories: false }), [editorStub])).config.get("editor.edits")).toBeUndefined();
        expect((await engineFor(tmp(), on())).config.get("editor.edits")).toBeUndefined();
    });
});

describe("launch", () => {
    it("runs `codex` in the project root when tools.codex names no command", async () => {
        const root = tmp();
        const { engine } = await engineFor(root, on());

        await engine.submit({ intent: "launch", input: { tool: ["codex"], noBuild: true } });

        expect(launched).toEqual([{ command: "codex", args: [], cwd: root }]);
    });

    it("runs the tools.codex command with its args, then the user's", async () => {
        const { engine } = await engineFor(tmp(), { tools: { codex: { command: "/opt/codex", args: ["--full-auto"] } } });

        await engine.submit({ intent: "launch", input: { tool: ["codex", "resume"], noBuild: true } });

        expect(launched.map(({ command, args }) => ({ command, args }))).toEqual([{ command: "/opt/codex", args: ["--full-auto", "resume"] }]);
    });
});
