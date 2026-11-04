import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { definePlugin } from "@sous-io/plugin-api";
import variablesPlugin from "@sous-io/plugin-variables";
import { MAX_ARGUMENT_BYTES } from "../src/tool.js";
import type { RunHeadlessResult } from "../src/types.js";
import { makeEngine, makeTmpDir, script, toolsConfig } from "./stand-ins.js";

const tmps: Array<{ cleanup(): void }> = [];

function tmp() {
    const dir = makeTmpDir();

    tmps.push(dir);

    return dir;
}

afterEach(() => {
    for (const dir of tmps.splice(0)) dir.cleanup();
});

/** A tool that records its arguments and standard input, then exits with `code`. */
function recorder(dir: string, name = "tool.mjs", code = 0): { file: string; log: string } {
    const log = path.join(dir, `${name}.log`);
    const file = script(
        dir,
        name,
        `import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), stdin: fs.readFileSync(0, "utf8") }) + "\\n");
process.stdout.write("out:" + process.argv.slice(2).join(","));
process.exit(${code});
`,
    );

    return { file, log };
}

const lines = (log: string) => fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; stdin: string });

describe("the tools key and its contributor", () => {
    it("adds a harness entity for a tool no plugin provides", async () => {
        const dir = tmp();
        const { engine } = await makeEngine(dir.path, [toolsConfig({ codex: { command: "codex" } })]);
        const config = await engine.buildConfig();

        expect(config.entities.get("harness", "codex")).toMatchObject({ id: "codex" });
        expect(config.entities.describe("harness")[0]).toMatchObject({ contributor: "harnesses.tools" });
    });

    it("leaves alone a tool a plugin already provides", async () => {
        const dir = tmp();
        const provider = definePlugin({
            name: "provider",
            version: "1.0.0",
            register: (sous) => sous.entities.add("harness", { id: "claude", launch: async () => ({ exitCode: 0, signal: null, durationMs: 0 }) }),
        });
        const { engine } = await makeEngine(dir.path, [provider, toolsConfig({ claude: { args: ["--x"] }, codex: { command: "codex" } })]);
        const config = await engine.buildConfig();
        const records = config.entities.describe("harness");

        expect(records.find((r) => r.id === "claude")?.plugin).toBe("provider");
        expect(records.map((r) => r.id).sort()).toEqual(["claude", "codex"]);
    });

    it("adds nothing without tools", async () => {
        const { engine } = await makeEngine(tmp().path);

        expect((await engine.buildConfig()).entities.list("harness")).toEqual([]);
    });

    it("rejects a tool setting of the wrong type", async () => {
        await expect(makeEngine(tmp().path, [toolsConfig({ codex: { command: 3 } })])).rejects.toThrow("not valid");
    });
});

describe("launch", () => {
    it("builds, then runs the tool with config args, then pass-through args, then the prompt file", async () => {
        const dir = tmp();
        const tool = recorder(dir.path);

        fs.writeFileSync(path.join(dir.path, "prompt.md"), "do the thing");

        const { engine, builds, calls } = await makeEngine(dir.path, [
            toolsConfig({ mytool: { command: process.execPath, args: [tool.file, "--config-arg"], promptFile: "prompt.md" } }),
        ]);
        const result = (await engine.submit({ intent: "launch", input: { tool: ["mytool", "-c", "--resume"] } })).toPlain();

        expect(builds.count).toBe(1);
        expect(lines(tool.log)[0]!.args).toEqual(["--config-arg", "-c", "--resume", "do the thing"]);
        expect(calls[0]).toMatchObject({ kind: "interactive", cwd: dir.path });
        expect(result).toMatchObject({ harness: "mytool", sessions: 1, last: { exitCode: 0 } });
    });

    it("skips the build with noBuild", async () => {
        const dir = tmp();
        const tool = recorder(dir.path);
        const { engine, builds } = await makeEngine(dir.path, [toolsConfig({ t: { command: process.execPath, args: [tool.file] } })]);

        await engine.submit({ intent: "launch", input: { tool: ["t"], noBuild: true } });

        expect(builds.count).toBe(0);
        expect(lines(tool.log)).toHaveLength(1);
    });

    it("does not start the tool when the build fails", async () => {
        const dir = tmp();
        const tool = recorder(dir.path);
        const { engine } = await makeEngine(dir.path, [toolsConfig({ t: { command: process.execPath, args: [tool.file] } })], { count: 0, ok: false });

        await expect(engine.submit({ intent: "launch", input: { tool: ["t"] } })).rejects.toThrow("The build failed, so t was not started");
        expect(fs.existsSync(tool.log)).toBe(false);
    });

    it("lists the available tools when the tool is unknown", async () => {
        const dir = tmp();
        const { engine } = await makeEngine(dir.path, [toolsConfig({ a: { command: "a" }, b: { command: "b" } })]);
        const error = await engine.submit({ intent: "launch", input: { tool: ["nope"] } }).catch((e: unknown) => e) as Error & { details: string[] };

        expect(error.message).toContain("Tool 'nope' not found");
        expect(error.details).toEqual(["Available tools: a, b"]);
    });

    it("reports a tool with no command", async () => {
        const dir = tmp();
        const { engine } = await makeEngine(dir.path, [toolsConfig({ a: { args: ["x"] } })]);

        await expect(engine.submit({ intent: "launch", input: { tool: ["a"], noBuild: true } })).rejects.toThrow('tools.a has no "command"');
    });

    /**
     * launch should fill in config variables in a tool's settings before it acts on them, as it did
     * before 1.0: `promptFile`, `command` and `args` all see `${projectRoot}`.
     *
     * tools: { a: { command: "<node>", promptFile: "${projectRoot}/AGENTS.md" } }
     * // the tool gets the content of <project>/AGENTS.md as its last argument
     */
    it("should fill in ${projectRoot} in promptFile and args", async () => {
        const dir = tmp();
        const tool = recorder(dir.path);

        fs.writeFileSync(path.join(dir.path, "AGENTS.md"), "from the project root");

        const { engine } = await makeEngine(dir.path, [
            variablesPlugin,
            toolsConfig({ a: { command: process.execPath, args: ["${projectRoot}/tool.mjs", "--root=${projectRoot}"], promptFile: "${projectRoot}/AGENTS.md" } }),
        ]);

        await engine.submit({ intent: "launch", input: { tool: ["a"], noBuild: true } });

        expect(lines(tool.log)[0]!.args).toEqual([`--root=${dir.path}`, "from the project root"]);
    });

    /**
     * An argument may hold a literal `${...}` meant for the tool, so an unknown name in `args`
     * should stay as written, while an unknown name in `promptFile` fails, naming the key.
     *
     * args: ["${notAVariable}"]          // passed as written
     * promptFile: "${nope}/AGENTS.md"    // ConfigError: Unresolved variable ${nope} in tools.a.promptFile
     */
    it("should keep unknown names in args, and refuse them in promptFile", async () => {
        const dir = tmp();
        const tool = recorder(dir.path);
        const literal = await makeEngine(dir.path, [variablesPlugin, toolsConfig({ a: { command: process.execPath, args: [tool.file, "${notAVariable}"] } })]);

        await literal.engine.submit({ intent: "launch", input: { tool: ["a"], noBuild: true } });
        expect(lines(tool.log)[0]!.args).toEqual(["${notAVariable}"]);

        const strict = await makeEngine(dir.path, [variablesPlugin, toolsConfig({ a: { command: process.execPath, promptFile: "${nope}/AGENTS.md" } })]);

        await expect(strict.engine.submit({ intent: "launch", input: { tool: ["a"], noBuild: true } })).rejects.toThrow("Unresolved variable ${nope} in tools.a.promptFile");
    });

    /**
     * Linux refuses one argument of 128 KiB or more with a bare `spawn E2BIG`, so launch should
     * refuse such a prompt file first, with its size and the limit.
     *
     * promptFile: "big.md" (144 KiB)
     * // ConfigError: The prompt file is too large to pass as one argument (144.0 KiB, limit 128 KiB): <path>
     */
    it("should refuse a prompt file too large to pass as one argument", async () => {
        const dir = tmp();

        fs.writeFileSync(path.join(dir.path, "big.md"), "x".repeat(144 * 1024));

        const { engine, calls } = await makeEngine(dir.path, [toolsConfig({ a: { command: process.execPath, promptFile: "big.md" } })]);

        await expect(engine.submit({ intent: "launch", input: { tool: ["a"], noBuild: true } })).rejects.toThrow(
            "The prompt file is too large to pass as one argument (144.0 KiB, limit 128 KiB)",
        );
        expect(calls).toEqual([]);
        expect(MAX_ARGUMENT_BYTES).toBe(131072);
    });

    it("reports a missing prompt file", async () => {
        const dir = tmp();
        const { engine } = await makeEngine(dir.path, [toolsConfig({ a: { command: process.execPath, promptFile: "gone.md" } })]);

        await expect(engine.submit({ intent: "launch", input: { tool: ["a"], noBuild: true } })).rejects.toThrow("promptFile not found");
    });

    it("says it could not start a command that does not exist", async () => {
        const dir = tmp();
        const { engine } = await makeEngine(dir.path, [toolsConfig({ a: { command: "/no/such/command-sous" } })]);

        await expect(engine.submit({ intent: "launch", input: { tool: ["a"], noBuild: true } })).rejects.toThrow("Failed to launch 'a'");
    });

    it("restarts with continuous, firing harnesses.launched per session", async () => {
        const dir = tmp();
        const counter = path.join(dir.path, "count");
        const tool = script(
            dir.path,
            "restart.mjs",
            `import fs from "node:fs";
const n = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")) : 0;
fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
`,
        );
        const sessions: number[] = [];
        const listener = definePlugin({
            name: "listener",
            version: "1.0.0",
            register(sous) {
                sous.on("harnesses.launched", (event) => {
                    sessions.push(event.payload.session);
                    // Stop after the third session by making the next launch fail.
                    if (event.payload.session === 3) throw new Error("stop");
                });
            },
        });
        const { engine } = await makeEngine(dir.path, [listener, toolsConfig({ t: { command: process.execPath, args: [tool] } })]);

        await engine.submit({ intent: "launch", input: { tool: ["t"], noBuild: true, continuous: true } }).catch(() => undefined);

        expect(sessions).toEqual([1, 2, 3]);
        expect(fs.readFileSync(counter, "utf8")).toBe("2");
    });
});

describe("harness.run-headless", () => {
    it("runs the tool's headless command with the prompt on stdin", async () => {
        const dir = tmp();
        const tool = recorder(dir.path);
        const { engine, calls } = await makeEngine(dir.path, [
            toolsConfig({ t: { command: "unused", headless: { command: process.execPath, args: [tool.file, "-p"] } } }),
        ]);
        const { run } = (await engine.submit({ intent: "harness.run-headless", input: { prompt: "hello" } })).toPlain() as unknown as RunHeadlessResult;

        expect(run).toMatchObject({ harness: "t", exitCode: 0, output: "out:-p" });
        expect(lines(tool.log)[0]).toEqual({ args: ["-p"], stdin: "hello" });
        expect(calls[0]).toMatchObject({ kind: "run", cwd: dir.path });
    });

    it("needs a name when several harnesses can run, and none when the only one can", async () => {
        const dir = tmp();
        const cfg = toolsConfig({ a: { command: process.execPath }, b: { command: process.execPath } });
        const { engine } = await makeEngine(dir.path, [cfg]);

        await expect(engine.submit({ intent: "harness.run-headless", input: { prompt: "x" } })).rejects.toThrow("Several harnesses");
        await expect(engine.submit({ intent: "harness.run-headless", input: { prompt: "x", harness: "zzz" } })).rejects.toThrow("No harness named 'zzz'");
    });

    it("fails when asked for a transcript the harness cannot read", async () => {
        const dir = tmp();
        const tool = recorder(dir.path);
        const { engine } = await makeEngine(dir.path, [toolsConfig({ t: { command: process.execPath, args: [tool.file] } })]);

        await expect(engine.submit({ intent: "harness.run-headless", input: { prompt: "x", transcript: true } })).rejects.toThrow("cannot read a transcript");
    });

    it("stops a run that passes its timeout", async () => {
        const dir = tmp();
        const slow = script(dir.path, "slow.mjs", "setTimeout(() => {}, 10000);\n");
        const { engine } = await makeEngine(dir.path, [toolsConfig({ t: { command: process.execPath, args: [slow] } })]);

        await expect(engine.submit({ intent: "harness.run-headless", input: { prompt: "x", timeoutMs: 200 } })).rejects.toThrow("did not finish");
    });
});
