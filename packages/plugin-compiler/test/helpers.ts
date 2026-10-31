/**
 * A real engine with plugin-compiler and stand-ins for the plugins it depends on, over a project in
 * a temporary directory.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine, type Engine } from "@sous-io/core";
import { BufferedReporter, definePlugin, type JsonObject, type PluginDefinition, type Sous } from "@sous-io/plugin-api";
import type { HashNameEntity } from "@sous-io/plugin-refs/types";
import { compilerPlugin } from "../src/index.js";
import type { CompileInput, CompileResult, CompilerPruneInput, CompilerPruneResult } from "../src/types.js";
import { hostStandIn, liquidStandIn, refsStandIn, variablesStandIn } from "./stand-ins.js";

/** A temporary project: its root, its `.sous/`, and helpers to write and read files in it. */
export interface TestProject {
    readonly root: string;
    readonly sousDir: string;
    /** Writes a file under the root (or at an absolute path), making its directories. */
    write(file: string, content: string): string;
    read(file: string): string;
    exists(file: string): boolean;
    /** An absolute path under the root. */
    at(...segments: string[]): string;
    remove(): void;
}

/** Makes a temporary project. */
export function makeProject(): TestProject {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sous-compiler-")));
    const sousDir = path.join(root, ".sous");

    fs.mkdirSync(sousDir, { recursive: true });

    const at = (...segments: string[]) => (segments.length === 1 && path.isAbsolute(segments[0]!) ? segments[0]! : path.join(root, ...segments));

    return {
        root,
        sousDir,
        at,
        write(file, content) {
            const full = at(file);

            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, content, "utf8");

            return full;
        },
        read: (file) => fs.readFileSync(at(file), "utf8"),
        exists: (file) => fs.existsSync(at(file)),
        remove: () => fs.rmSync(root, { recursive: true, force: true }),
    };
}

/** What a test engine is built from. */
export interface CompilerSetup {
    /** The config: `compilation`, `_aliases`, `_vars`. */
    config?: JsonObject | (() => JsonObject);
    /** More `#` names. */
    hashNames?: HashNameEntity[];
    /** Names declared secret. */
    secrets?: string[];
    /** Registers more on a plugin of the test's own (transforms, a namespace resolver). */
    register?: (sous: Sous) => void;
    env?: Record<string, string>;
    /** More plugins. */
    plugins?: PluginDefinition[];
    /** Uses the real plugin-host, plugin-variables, plugin-liquid and plugin-refs instead of the stand-ins. */
    real?: boolean;
}

/** An engine, and shorthands for the compiler's intents. */
export interface TestCompiler {
    readonly engine: Engine;
    readonly reporter: BufferedReporter;
    compile(input?: CompileInput): Promise<CompileResult>;
    prune(input?: CompilerPruneInput): Promise<CompilerPruneResult>;
    /** Rebuilds the config (after changing what `config` returns). */
    rebuild(): Promise<void>;
    /** The messages reported, joined. */
    output(): string;
}

/** The real plugins the compiler depends on, with any extra `#` names on a plugin of their own. */
async function realPlugins(hashNames: HashNameEntity[]): Promise<PluginDefinition[]> {
    const [{ hostPlugin }, { variablesPlugin }, { liquidPlugin }, { refsPlugin }] = await Promise.all([
        import("@sous-io/plugin-host"),
        import("@sous-io/plugin-variables"),
        import("@sous-io/plugin-liquid"),
        import("@sous-io/plugin-refs"),
    ]);
    const names = definePlugin({
        name: "test-hash-names",
        version: "1.0.0",
        register(sous) {
            for (const entity of hashNames) {
                sous.entities.add("hash-name", entity);
            }
        },
    });

    return [hostPlugin, variablesPlugin, liquidPlugin, refsPlugin, names];
}

/** Makes an engine for a project. */
export async function makeCompiler(project: TestProject, setup: CompilerSetup = {}): Promise<TestCompiler> {
    const reporter = new BufferedReporter();
    const configPlugin = definePlugin({
        name: "test-config",
        version: "1.0.0",
        register(sous) {
            sous.config.contribute({
                id: "test-config",
                contribute(config) {
                    const value = typeof setup.config === "function" ? setup.config() : setup.config;

                    if (value) {
                        config.root().merge(value);
                    }
                },
            });
            setup.register?.(sous);
        },
    });
    const engine = createEngine({
        builtIns: [
            ...(setup.real ? await realPlugins(setup.hashNames ?? []) : [hostStandIn(), variablesStandIn({ secrets: setup.secrets ?? [] }), liquidStandIn(), refsStandIn(setup.hashNames)]),
            compilerPlugin,
            configPlugin,
            ...(setup.plugins ?? []),
        ],
        project: { root: project.root, sousDir: project.sousDir, configPath: path.join(project.sousDir, "sous.config.json"), confDir: path.join(project.sousDir, "conf.d") },
        env: { HOME: path.join(project.root, "home"), SOUS_HOME: path.join(project.root, "sous-home"), ...(setup.env ?? {}) },
        reporter,
    });

    await engine.buildConfig();

    return {
        engine,
        reporter,
        compile: async (input = {}) => (await engine.handle.submit({ intent: "compiler.compile", input }, { reporter })).toPlain() as unknown as CompileResult,
        prune: async (input = {}) => (await engine.handle.submit({ intent: "compiler.prune", input }, { reporter })).toPlain() as unknown as CompilerPruneResult,
        rebuild: async () => {
            await engine.buildConfig();
        },
        output: () => reporter.messages.map((entry) => entry.message).join("\n"),
    };
}

/** The error messages of a compile, joined. */
export function errorsOf(result: CompileResult): string {
    return result.problems
        .filter((problem) => problem.level === "error")
        .map((problem) => problem.message)
        .join("\n");
}

/** Copies a fixture directory from `test/fixtures` into the project; returns where it went. */
export function copyFixture(project: TestProject, name: string): string {
    const dest = project.at(name);

    fs.cpSync(path.join(import.meta.dirname, "fixtures", name), dest, { recursive: true });

    return dest;
}

/** One compile of the given `compilation` config, in a fresh engine. */
export async function compileOnce(
    project: TestProject,
    compilation: Record<string, unknown>,
    input: CompileInput = {},
    setup: Omit<CompilerSetup, "config"> & { config?: JsonObject } = {},
): Promise<{ result: CompileResult; compiler: TestCompiler }> {
    const compiler = await makeCompiler(project, { ...setup, config: { ...(setup.config ?? {}), compilation: compilation as JsonObject } });

    return { result: await compiler.compile(input), compiler };
}
