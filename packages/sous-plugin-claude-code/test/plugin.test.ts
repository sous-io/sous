import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine } from "@sous-io/core";
import { BufferedReporter, definePlugin, IntentOutputs, jsonSchema, type PluginDefinition } from "@sous-io/sous-plugin-api";
import type { HostProcesses, ProcessResult } from "@sous-io/sous-plugin-host/types";
import type { RunHeadlessResult } from "@sous-io/sous-plugin-harnesses/types";
import type { CompilationTarget } from "@sous-io/sous-plugin-compiler/types";
import type { ActiveRecipeContent } from "@sous-io/sous-plugin-recipes/types";
import type { MigrationDefinition } from "@sous-io/sous-plugin-migrations/types";
import { spawn } from "node:child_process";
import harnessesPlugin from "@sous-io/sous-plugin-harnesses";
import claudeCodePlugin from "../src/index.js";
import { pluginFolderOf, registerReloadLine, reloadLine } from "../src/reload.js";
import packageJson from "../package.json" with { type: "json" };

const dirs: string[] = [];

function tmp(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sous-claude-code-"));

    dirs.push(dir);

    return dir;
}

afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs a stand-in process; a stand-in for `host.processes`. */
const processes: HostProcesses = {
    run: (command, args, options = {}) =>
        new Promise<ProcessResult>((resolve, reject) => {
            const began = Date.now();
            const child = spawn(command, [...args], { cwd: options.cwd, stdio: "pipe" });
            let stdout = "";
            let stderr = "";

            child.stdout.on("data", (chunk) => (stdout += chunk));
            child.stderr.on("data", (chunk) => (stderr += chunk));
            child.on("error", reject);
            child.on("close", (exitCode, signal) =>
                resolve({ command, args, exitCode, signal, stdout, stderr, durationMs: Date.now() - began, timedOut: false }),
            );
            child.stdin.end(options.input ?? "");
        }),
    runSync: () => {
        throw new Error("not used");
    },
    runInteractive: async (command, args, options = {}) =>
        new Promise((resolve, reject) => {
            const began = Date.now();
            const child = spawn(command, [...args], { cwd: options.cwd, stdio: "ignore" });

            child.on("error", reject);
            child.on("close", (exitCode, signal) => resolve({ exitCode, signal, durationMs: Date.now() - began }));
        }),
    which: async () => undefined,
};

const stubs: PluginDefinition[] = [
    definePlugin({
        name: "@sous-io/sous-plugin-host",
        version: packageJson.version,
        register: (sous) => {
            sous.services.add("host.processes", () => processes, { lifetime: "singleton" });
            sous.entities.define("pointer-file", jsonSchema({ type: "object", required: ["id", "fileName"] }));
        },
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
    // The content-kind kind and recipes.contents sous-plugin-recipes owns; recipes.contents gives `world.contents`.
    definePlugin({
        name: "@sous-io/sous-plugin-recipes",
        version: packageJson.version,
        register: (sous) => {
            sous.entities.define("content-kind", jsonSchema({ type: "object", required: ["id", "description"] }));
            sous.services.add(
                "recipes.contents",
                () => ({ of: (_config: unknown, kind: string) => world.contents[kind] ?? [], entries: () => [], files: () => [] }) as never,
                { lifetime: "singleton" },
            );
        },
    }),
    // sous.migrations, which the migrations plugin adds; what is added is kept in `world.migrations`.
    definePlugin({
        name: "@sous-io/sous-plugin-migrations",
        version: packageJson.version,
        register: (sous) => sous.extensions.add("migrations", () => ({ add: (migration) => world.migrations.push(migration) })),
    }),
    // The compilation key sous-plugin-compiler owns.
    definePlugin({
        name: "@sous-io/sous-plugin-compiler",
        version: packageJson.version,
        register: (sous) => sous.entities.add("config-key", { id: "compilation", schema: jsonSchema({}) }),
    }),
];

/** What the recipes stand-in gives as each kind's `recipes.contents`; reset after each test. */
const world: { contents: Record<string, ActiveRecipeContent[]>; migrations: MigrationDefinition[] } = { contents: {}, migrations: [] };

afterEach(() => {
    world.contents = {};
    world.migrations = [];
});

function config(values: Record<string, unknown>): PluginDefinition {
    return definePlugin({
        name: "test-config",
        version: "1.0.0",
        register: (sous) => sous.config.contribute({ id: "test-config", contribute: (c) => c.root().merge(values as never) }),
    });
}

async function engineFor(root: string, values: Record<string, unknown> = {}) {
    const engine = createEngine({
        builtIns: [...stubs, harnessesPlugin, claudeCodePlugin, config(values)],
        reporter: new BufferedReporter(),
        project: { root, sousDir: path.join(root, ".sous"), configPath: undefined, confDir: path.join(root, ".sous", "conf.d") },
    });

    return { engine, config: await engine.buildConfig() };
}

/** A fake `claude`: prints a stream-json session and records how it was called. */
function fakeClaude(dir: string, exitCode = 0): { file: string; log: string } {
    const log = path.join(dir, "calls.log");
    const lines = [
        { type: "system", subtype: "init", model: "fake-model" },
        { type: "assistant", message: { content: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.md" } }] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "file body" }] }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
        { type: "result", subtype: "success", is_error: false, result: "Done." },
    ];
    const file = path.join(dir, "fake-claude.mjs");

    fs.writeFileSync(
        file,
        `import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), stdin: fs.readFileSync(0, "utf8") }) + "\\n");
console.log("not json, skipped");
for (const line of ${JSON.stringify(lines)}) console.log(JSON.stringify(line));
process.exit(${exitCode});
`,
    );

    return { file, log };
}

const calls = (log: string) => fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { args: string[]; stdin: string });

describe("entities", () => {
    it("adds the claude-code harness, and the claude-code skill and memory targets", async () => {
        const { config: built } = await engineFor(tmp());

        expect(built.entities.get("harness", "claude-code")).toMatchObject({ id: "claude-code" });
        expect(built.entities.get("skill-target", "claude-code")).toMatchObject({ harness: "claude-code", directory: ".claude/skills" });
        expect(built.entities.get("memory-target", "claude-code")).toEqual({
            id: "claude-code",
            harness: "claude-code",
            outputPath: "${projectRoot}/.claude/rules/SOUS-MEMORIES.md",
            backupExisting: true,
        });
        expect(built.entities.get("pointer-file", "claude-code")).toEqual({ id: "claude-code", fileName: "CLAUDE.md" });
    });

    /**
     * memoriesOutputPath moves the memories file, for example back to the root CLAUDE.md.
     *
     * { memoriesOutputPath: "${projectRoot}/CLAUDE.md" } -> memory-target outputPath "${projectRoot}/CLAUDE.md"
     */
    it("lets memoriesOutputPath move the memories file", async () => {
        const { config: built } = await engineFor(tmp(), {
            plugins: { options: { "@sous-io/sous-plugin-claude-code": { memoriesOutputPath: "${projectRoot}/CLAUDE.md" } } },
        });

        expect(built.entities.get("memory-target", "claude-code")?.outputPath).toBe("${projectRoot}/CLAUDE.md");
    });

    it("lets the plugin's options move the skills and turn memories off", async () => {
        const { config: built } = await engineFor(tmp(), {
            plugins: { options: { "@sous-io/sous-plugin-claude-code": { skillsDirectory: "agents/skills", memories: false } } },
        });

        expect(built.entities.get("skill-target", "claude-code")?.directory).toBe("agents/skills");
        expect(built.entities.get("memory-target", "claude-code")).toBeUndefined();
    });

    it("keeps the claude-code harness, not a generic tool, when tools.claude-code is written", async () => {
        const { config: built } = await engineFor(tmp(), { tools: { "claude-code": { args: ["--x"] } } });

        expect(built.entities.describe("harness").map((r) => [r.id, r.plugin])).toEqual([["claude-code", "@sous-io/sous-plugin-claude-code"]]);
    });
});

describe("launch", () => {
    it("runs the claude command with the tools.claude-code args, then the user's", async () => {
        const root = tmp();
        const fake = fakeClaude(root);
        const { engine } = await engineFor(root, { tools: { "claude-code": { command: process.execPath, args: [fake.file, "--model", "opus"] } } });

        await engine.submit({ intent: "launch", input: { tool: ["claude-code", "--resume"] } });

        expect(calls(fake.log)[0]!.args).toEqual(["--model", "opus", "--resume"]);
    });

    it("uses the command `claude` when tools.claude-code names none", async () => {
        const root = tmp();
        const seen: string[] = [];
        const spy = definePlugin({
            name: "spy",
            version: "1.0.0",
            register: (sous) =>
                sous.services.replace("host.processes", () => ({ ...processes, runInteractive: async (command) => { seen.push(command); return { exitCode: 0, signal: null, durationMs: 0 }; } }), { lifetime: "singleton" }),
        });
        const engine = createEngine({
            builtIns: [...stubs, harnessesPlugin, claudeCodePlugin, spy],
            reporter: new BufferedReporter(),
            project: { root, sousDir: path.join(root, ".sous"), configPath: undefined, confDir: path.join(root, ".sous", "conf.d") },
        });

        await engine.buildConfig();
        await engine.submit({ intent: "launch", input: { tool: ["claude-code"], noBuild: true } });

        expect(seen).toEqual(["claude"]);
    });
});

describe("headless runs and transcripts", () => {
    it("runs `claude -p --output-format stream-json` with the prompt on stdin and reads the answer", async () => {
        const root = tmp();
        const fake = fakeClaude(root);
        const { engine } = await engineFor(root, { tools: { "claude-code": { command: process.execPath, headless: { args: [fake.file] } } } });
        const { run } = (await engine.submit({ intent: "harness.run-headless", input: { prompt: "say hi", model: "sonnet" } })).toPlain() as unknown as RunHeadlessResult;

        expect(calls(fake.log)[0]).toEqual({
            args: ["-p", "--output-format", "stream-json", "--verbose", "--model", "sonnet"],
            stdin: "say hi",
        });
        expect(run).toMatchObject({ harness: "claude-code", exitCode: 0, output: "Done." });
    });

    it("reads the transcript: system, assistant text, tool call, tool result", async () => {
        const root = tmp();
        const fake = fakeClaude(root);
        const { engine } = await engineFor(root, { tools: { "claude-code": { command: process.execPath, headless: { args: [fake.file] } } } });
        const { transcript } = (await engine.submit({ intent: "harness.run-headless", input: { prompt: "x", transcript: true } })).toPlain() as unknown as RunHeadlessResult;

        expect(transcript?.harness).toBe("claude-code");
        expect(transcript?.entries).toEqual([
            { role: "system", text: "Session started (fake-model)" },
            { role: "assistant", text: "Let me look." },
            { role: "assistant", text: "", tool: "Read", input: { file_path: "a.md" } },
            { role: "tool", text: "file body", tool: "Read" },
            { role: "assistant", text: "Done." },
        ]);
    });

    it("reports a non-zero exit with the answer it had", async () => {
        const root = tmp();
        const fake = fakeClaude(root, 3);
        const { engine } = await engineFor(root, { tools: { "claude-code": { command: process.execPath, headless: { args: [fake.file] } } } });
        const { run } = (await engine.submit({ intent: "harness.run-headless", input: { prompt: "x" } })).toPlain() as unknown as RunHeadlessResult;

        expect(run.exitCode).toBe(3);
    });

    it("falls back to the last assistant text when there is no result line", async () => {
        const { finalText } = await import("../src/transcript.js");

        expect(finalText([{ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }])).toBe("partial");
        expect(finalText([])).toBe("");
    });
});

/** One recipe's content of a kind, as `recipes.contents` lists it: each path relative to the pattern's fixed part. */
function content(recipe: string, kind: string, base: string, files: string[], inline: Record<string, string> = {}): ActiveRecipeContent {
    const dir = path.dirname(base);

    return {
        recipe,
        kind,
        entry: { recipe, dir, kind, include: [] },
        files: [
            ...files.map((file) => ({ path: path.relative(dir, path.join(base, file)), file: path.join(base, file), base })),
            ...Object.entries(inline).map(([file, text]) => ({ path: path.relative(dir, path.join(base, file)), file: path.join(base, file), base, content: text })),
        ],
    };
}

const targetsOf = (built: { get(path: string): unknown }) => (built.get("compilation.targets") as CompilationTarget[] | undefined) ?? [];

describe("content kinds", () => {
    it("registers claude-code-plugin and claude-code-agent", async () => {
        const { config: built } = await engineFor(tmp());

        expect(built.entities.list("content-kind").map((kind) => kind.id).sort()).toEqual(["claude-code-agent", "claude-code-plugin"]);
    });

    /**
     * A plugin folder goes under Claude Code's skills directory, at its path from the include
     * pattern's fixed part, marked for Claude Code.
     *
     * recipe a/harness, include plugins/**: plugins/session-harness/.claude-plugin/plugin.json
     * // -> { entryPoint: ".../plugins/session-harness/.claude-plugin/plugin.json", globBase: ".../plugins",
     * //      outputs: [{ destinationDir: "${projectRoot}/.claude/skills", harness: "claude-code" }] }
     */
    it("writes a claude-code-plugin folder under .claude/skills, marked for Claude Code", async () => {
        const base = path.resolve("/store/a/harness/plugins");

        world.contents["claude-code-plugin"] = [
            content("a/harness", "claude-code-plugin", base, ["session-harness/.claude-plugin/plugin.json", "session-harness/scripts/run.tpl.sh"]),
        ];

        const { config: built } = await engineFor(tmp());
        const origin = { plugin: "@sous-io/sous-plugin-claude-code", recipe: "a/harness" };
        const outputs = [{ destinationDir: "${projectRoot}/.claude/skills", harness: "claude-code" }];

        expect(targetsOf(built)).toEqual([
            {
                id: "claude-code-plugin/a/harness/session-harness/.claude-plugin/plugin.json",
                entryPoint: path.join(base, "session-harness/.claude-plugin/plugin.json"),
                globBase: base,
                origin,
                outputs,
            },
            {
                id: "claude-code-plugin/a/harness/session-harness/scripts/run.tpl.sh",
                entryPoint: path.join(base, "session-harness/scripts/run.tpl.sh"),
                globBase: base,
                origin,
                outputs,
            },
        ]);
    });

    /** The skillsDirectory option moves plugins with the skills. */
    it("follows the skillsDirectory option for plugins", async () => {
        world.contents["claude-code-plugin"] = [content("a/harness", "claude-code-plugin", path.resolve("/store/a/harness/plugins"), ["sh/.claude-plugin/plugin.json"])];

        const { config: built } = await engineFor(tmp(), { plugins: { options: { "@sous-io/sous-plugin-claude-code": { skillsDirectory: "agents/skills" } } } });

        expect(targetsOf(built)[0]?.outputs).toEqual([{ destinationDir: "${projectRoot}/agents/skills", harness: "claude-code" }]);
    });

    /**
     * Agent files go to .claude/agents/, keeping their sub-folders; inline content is written from a
     * content target, rendered only when its path holds `.tpl.`.
     *
     * agents/reviewer.tpl.md, agents/review/security.md, inline agents/inline.md
     * // -> destinationDir .claude/agents (twice), destinationFile .claude/agents/inline.md
     */
    it("writes claude-code-agent files to .claude/agents, keeping sub-folders", async () => {
        const base = path.resolve("/store/a/agents/agents");

        world.contents["claude-code-agent"] = [content("a/agents", "claude-code-agent", base, ["reviewer.tpl.md", "review/security.md"], { "inline.md": "Be brief." })];

        const { config: built } = await engineFor(tmp());
        const targets = targetsOf(built);

        expect(targets.map((target) => target.id)).toEqual([
            "claude-code-agent/a/agents/reviewer.tpl.md",
            "claude-code-agent/a/agents/review/security.md",
            "claude-code-agent/a/agents/inline.md",
        ]);
        expect(targets[1]).toMatchObject({
            entryPoint: path.join(base, "review/security.md"),
            globBase: base,
            outputs: [{ destinationDir: "${projectRoot}/.claude/agents", harness: "claude-code" }],
        });
        expect(targets[2]).toMatchObject({
            content: "{% raw %}Be brief.{% endraw %}",
            outputs: [{ destinationFile: "${projectRoot}/.claude/agents/inline.md", harness: "claude-code" }],
        });
    });
});

describe("the /reload-plugins line", () => {
    it("finds the nearest folder holding .claude-plugin/plugin.json, inside the project", () => {
        const root = path.resolve("/p");
        const manifest = path.join(root, ".claude/skills/sh/.claude-plugin/plugin.json");
        const exists = (file: string) => file === manifest;

        expect(pluginFolderOf(path.join(root, ".claude/skills/sh/hooks/hooks.json"), root, exists)).toBe(path.join(root, ".claude/skills/sh"));
        expect(pluginFolderOf(manifest, root, exists)).toBe(path.join(root, ".claude/skills/sh"));
        expect(pluginFolderOf(path.join(root, ".claude/skills/plain/SKILL.md"), root, exists)).toBeUndefined();
        // A plugin removed whole: its manifest is among the removed files.
        const removed = new Set([path.join(root, ".claude/skills/gone/.claude-plugin/plugin.json")]);

        expect(pluginFolderOf(path.join(root, ".claude/skills/gone/x.md"), root, () => false, removed)).toBe(path.join(root, ".claude/skills/gone"));
    });

    it("words the line for one plugin, several, and a dry run", () => {
        expect(reloadLine([], false)).toBeUndefined();
        expect(reloadLine(["sh"], false)).toBe("A Claude Code plugin changed (sh). Run /reload-plugins in any open Claude Code session.");
        expect(reloadLine(["sh", "kw", "sh"], true)).toBe(
            "Claude Code plugins would change (kw, sh). Run /reload-plugins in any open Claude Code session after the build.",
        );
    });

    /**
     * What the compiler wrote and the prune removed during one build decides the line, printed once
     * when the build ends; unchanged files do not count.
     */
    it("prints the line when a build changed a plugin's files, and not otherwise", () => {
        const root = path.resolve("/p");
        const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
        const notices: string[] = [];
        const ctx = { chain: { id: 7 }, project: { root }, reporter: { notice: (line: string) => notices.push(line) } };
        const hooks = path.join(root, ".claude/skills/sh/hooks/hooks.json");
        const exists = (file: string) => file === path.join(root, ".claude/skills/sh/.claude-plugin/plugin.json");

        registerReloadLine({ on: ((name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler)) as never }, exists);

        handlers.get("compiler.wrote")!({ payload: { dryRun: false, files: [{ file: hooks, action: "unchanged" }] } }, ctx);
        handlers.get("build.after")!({}, ctx);
        expect(notices).toEqual([]);

        handlers.get("compiler.wrote")!({ payload: { dryRun: false, files: [{ file: hooks, action: "updated" }] } }, ctx);
        handlers.get("compiler.pruned")!({ payload: { dryRun: false, removed: [path.join(root, ".claude/skills/plain/SKILL.md")] } }, ctx);
        handlers.get("build.after")!({}, ctx);
        expect(notices).toEqual(["A Claude Code plugin changed (sh). Run /reload-plugins in any open Claude Code session."]);
    });
});
