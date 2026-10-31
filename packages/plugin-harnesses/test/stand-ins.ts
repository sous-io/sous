/**
 * Stand-ins for the plugins plugin-harnesses depends on: `host.processes` (real child processes, so
 * a test can run a small script as the "tool") and the `build` intent. No real tool is ever run.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine, type Engine } from "@sous-io/core";
import { BufferedReporter, definePlugin, IntentOutputs, type PluginDefinition, type ProjectInfo } from "@sous-io/plugin-api";
import type { HostProcesses, ProcessResult } from "@sous-io/plugin-host/types";
import harnessesPlugin from "../src/index.js";

/** A temporary directory, removed by `cleanup()`. */
export function makeTmpDir(prefix = "sous-harnesses-"): { path: string; cleanup(): void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

    return { path: dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A project rooted at `root`. */
export function projectAt(root: string): ProjectInfo {
    return { root, sousDir: path.join(root, ".sous"), configPath: path.join(root, ".sous", "sous.config.yaml"), confDir: path.join(root, ".sous", "conf.d") };
}

/** Writes a node script and returns its path. The script gets `argv` and `stdin`. */
export function script(dir: string, name: string, body: string): string {
    const file = path.join(dir, name);

    fs.writeFileSync(file, body, "utf8");

    return file;
}

/** What a stand-in `host.processes` was asked to run. */
export interface ProcessCall {
    kind: "run" | "interactive";
    command: string;
    args: readonly string[];
    cwd?: string;
    input?: string;
}

/** `host.processes`, running real child processes and recording each call. */
export function processesStandIn(calls: ProcessCall[]): HostProcesses {
    const start = (command: string, args: readonly string[], options: { cwd?: string; input?: string; timeoutMs?: number; stdio: "pipe" | "inherit" }) =>
        new Promise<ProcessResult>((resolve, reject) => {
            const began = Date.now();
            const child = spawn(command, [...args], { cwd: options.cwd, stdio: options.stdio === "inherit" ? ["ignore", "ignore", "ignore"] : "pipe" });
            let stdout = "";
            let stderr = "";
            let timedOut = false;
            const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; child.kill(); }, options.timeoutMs);

            child.stdout?.on("data", (chunk) => (stdout += chunk));
            child.stderr?.on("data", (chunk) => (stderr += chunk));
            child.on("error", reject);
            child.on("close", (exitCode, signal) => {
                clearTimeout(timer);
                resolve({ command, args, exitCode, signal, stdout, stderr, durationMs: Date.now() - began, timedOut });
            });
            child.stdin?.end(options.input ?? "");
        });

    return {
        async run(command, args, options = {}) {
            calls.push({ kind: "run", command, args, ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.input === undefined ? {} : { input: options.input }) });

            return start(command, args, { stdio: "pipe", ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.input === undefined ? {} : { input: options.input }), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
        },
        runSync: () => {
            throw new Error("not used");
        },
        async runInteractive(command, args, options = {}) {
            calls.push({ kind: "interactive", command, args, ...(options.cwd ? { cwd: options.cwd } : {}) });
            const result = await start(command, args, { stdio: "inherit", ...(options.cwd ? { cwd: options.cwd } : {}) });

            return { exitCode: result.exitCode, signal: result.signal, durationMs: result.durationMs };
        },
        which: async () => undefined,
    };
}

/** Stands in for plugin-host. */
export function hostStandIn(calls: ProcessCall[]): PluginDefinition {
    return definePlugin({
        name: "@sous-io/plugin-host",
        version: "0.2.34",
        register(sous) {
            sous.services.add("host.processes", () => processesStandIn(calls), { lifetime: "singleton" });
        },
    });
}

/** Stands in for plugin-build: a `build` intent that records its runs. */
export function buildStandIn(builds: { count: number; ok?: boolean }): PluginDefinition {
    return definePlugin({
        name: "@sous-io/plugin-build",
        version: "0.2.34",
        register(sous) {
            sous.intents.add({
                intent: "build",
                handle: () => {
                    builds.count++;

                    return IntentOutputs.of({ ok: builds.ok ?? true, dryRun: false, watching: false, prepared: {} }) as never;
                },
            });
        },
    });
}

/** Sets the `tools` config, as a config file would. */
export function toolsConfig(tools: Record<string, unknown>): PluginDefinition {
    return definePlugin({
        name: "test-tools-config",
        version: "1.0.0",
        register(sous) {
            sous.config.contribute({ id: "test-tools", contribute: (config) => config.atPath("tools").set(tools as never) });
        },
    });
}

/** An engine with plugin-harnesses, its stand-ins and any extra plugins. */
export async function makeEngine(root: string, extra: PluginDefinition[] = [], builds: { count: number; ok?: boolean } = { count: 0 }): Promise<{ engine: Engine; reporter: BufferedReporter; calls: ProcessCall[]; builds: { count: number } }> {
    const reporter = new BufferedReporter();
    const calls: ProcessCall[] = [];
    const engine = createEngine({
        builtIns: [hostStandIn(calls), buildStandIn(builds), harnessesPlugin, ...extra],
        reporter,
        project: projectAt(root),
    });

    await engine.buildConfig();

    return { engine, reporter, calls, builds };
}
