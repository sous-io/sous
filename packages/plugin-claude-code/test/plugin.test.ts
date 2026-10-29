import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine } from "@sous-io/core";
import { BufferedReporter, definePlugin, jsonSchema, type PluginDefinition } from "@sous-io/plugin-api";
import type { HostProcesses, ProcessResult } from "@sous-io/plugin-host/types";
import type { RunHeadlessResult } from "@sous-io/plugin-harnesses/types";
import { spawn } from "node:child_process";
import harnessesPlugin from "@sous-io/plugin-harnesses";
import claudeCodePlugin from "../src/index.js";

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
        name: "@sous-io/plugin-host",
        version: "0.2.34",
        register: (sous) => sous.services.add("host.processes", () => processes, { lifetime: "singleton" }),
    }),
    definePlugin({
        name: "@sous-io/plugin-build",
        version: "0.2.34",
        register: (sous) => sous.intents.add({ intent: "build", handle: () => ({ ok: true }) as never }),
    }),
    // The kinds plugin-skills and plugin-memories own.
    definePlugin({
        name: "@sous-io/plugin-skills",
        version: "0.2.34",
        register: (sous) => sous.entities.define("skill-target", jsonSchema({ type: "object", required: ["id", "directory"] })),
    }),
    definePlugin({
        name: "@sous-io/plugin-memories",
        version: "0.2.34",
        register: (sous) => sous.entities.define("memory-target", jsonSchema({ type: "object", required: ["id", "fileName"] })),
    }),
];

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
    it("adds the claude harness, and the claude-code skill and memory targets", async () => {
        const { config: built } = await engineFor(tmp());

        expect(built.entities.get("harness", "claude")).toMatchObject({ id: "claude" });
        expect(built.entities.get("skill-target", "claude-code")).toMatchObject({ harness: "claude", directory: ".claude/skills" });
        expect(built.entities.get("memory-target", "claude-code")).toMatchObject({ harness: "claude", fileName: "CLAUDE.md", readIn: "any-directory" });
    });

    it("lets the plugin's options move the skills and turn memories off", async () => {
        const { config: built } = await engineFor(tmp(), {
            plugins: { options: { "@sous-io/plugin-claude-code": { skillsDirectory: "agents/skills", memories: false } } },
        });

        expect(built.entities.get("skill-target", "claude-code")?.directory).toBe("agents/skills");
        expect(built.entities.get("memory-target", "claude-code")).toBeUndefined();
    });

    it("keeps the claude harness, not a generic tool, when tools.claude is written", async () => {
        const { config: built } = await engineFor(tmp(), { tools: { claude: { args: ["--x"] } } });

        expect(built.entities.describe("harness").map((r) => [r.id, r.plugin])).toEqual([["claude", "@sous-io/plugin-claude-code"]]);
    });
});

describe("launch", () => {
    it("runs the claude command with the tools.claude args, then the user's", async () => {
        const root = tmp();
        const fake = fakeClaude(root);
        const { engine } = await engineFor(root, { tools: { claude: { command: process.execPath, args: [fake.file, "--model", "opus"] } } });

        await engine.submit({ intent: "launch", input: { tool: ["claude", "--resume"] } });

        expect(calls(fake.log)[0]!.args).toEqual(["--model", "opus", "--resume"]);
    });

    it("uses the command `claude` when tools.claude names none", async () => {
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
        await engine.submit({ intent: "launch", input: { tool: ["claude"], noBuild: true } });

        expect(seen).toEqual(["claude"]);
    });
});

describe("headless runs and transcripts", () => {
    it("runs `claude -p --output-format stream-json` with the prompt on stdin and reads the answer", async () => {
        const root = tmp();
        const fake = fakeClaude(root);
        const { engine } = await engineFor(root, { tools: { claude: { command: process.execPath, headless: { args: [fake.file] } } } });
        const { run } = (await engine.submit({ intent: "harness.run-headless", input: { prompt: "say hi", model: "sonnet" } })) as RunHeadlessResult;

        expect(calls(fake.log)[0]).toEqual({
            args: ["-p", "--output-format", "stream-json", "--verbose", "--model", "sonnet"],
            stdin: "say hi",
        });
        expect(run).toMatchObject({ harness: "claude", exitCode: 0, output: "Done." });
    });

    it("reads the transcript: system, assistant text, tool call, tool result", async () => {
        const root = tmp();
        const fake = fakeClaude(root);
        const { engine } = await engineFor(root, { tools: { claude: { command: process.execPath, headless: { args: [fake.file] } } } });
        const { transcript } = (await engine.submit({ intent: "harness.run-headless", input: { prompt: "x", transcript: true } })) as RunHeadlessResult;

        expect(transcript?.harness).toBe("claude");
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
        const { engine } = await engineFor(root, { tools: { claude: { command: process.execPath, headless: { args: [fake.file] } } } });
        const { run } = (await engine.submit({ intent: "harness.run-headless", input: { prompt: "x" } })) as RunHeadlessResult;

        expect(run.exitCode).toBe(3);
    });

    it("falls back to the last assistant text when there is no result line", async () => {
        const { finalText } = await import("../src/transcript.js");

        expect(finalText([{ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }])).toBe("partial");
        expect(finalText([])).toBe("");
    });
});
