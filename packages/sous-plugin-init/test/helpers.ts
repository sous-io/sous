/**
 * Stand-ins for the tests: a context whose host services are the real ones from sous-plugin-host (they
 * only touch the temporary directory) and whose config loader and build are stand-ins.
 */

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BufferedReporter, type Context, IntentOutputs, scriptedPrompter } from "@sous-io/sous-plugin-api";
import type { BuildResult } from "@sous-io/sous-plugin-build/types";
import type { ConfigFilesLoader } from "@sous-io/sous-plugin-config-files/types";
import { createDirectories, createGitignore } from "@sous-io/sous-plugin-host";
import { handle as hooksHandle } from "../src/init-hooks.js";
import type { InitHooksInput } from "../src/types.js";

/** What a stand-in git runner answers, by the first two arguments of the command. */
export interface FakeGitOptions {
    /** The top of the repository `rev-parse --show-toplevel` names; `undefined` for "not a repository". */
    top?: string;
    /** What `rev-parse --git-path hooks` prints. Default `.git/hooks`. */
    hooksPath?: string;
}

/** A stand-in `git.runner` for the hook commands, recording each command. */
export function fakeGitRunner(options: FakeGitOptions): { runner: unknown; commands: string[][] } {
    const commands: string[][] = [];
    const ok = (args: string[], stdout: string) => ({ args, exitCode: 0, stdout, stderr: "", durationMs: 0 });
    const runner = {
        run: async (args: string[]) => {
            commands.push(args);

            if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
                return options.top === undefined ? { args, exitCode: 128, stdout: "", stderr: "fatal: not a git repository", durationMs: 0 } : ok(args, `${options.top}\n`);
            }

            if (args[0] === "rev-parse" && args[1] === "--git-path") {
                return ok(args, `${options.hooksPath ?? ".git/hooks"}\n`);
            }

            if (args[0] === "rev-parse") {
                return ok(args, "true");
            }

            return ok(args, args[0] === "ls-files" ? args.slice(2).join("\n") : "");
        },
    };

    return { runner, commands };
}

/** A stand-in `package-manager` entity that claims every project, like pnpm. */
export const fakePnpm = {
    id: "pnpm",
    detect: async () => ({ id: "pnpm", detected: true }),
    installed: async () => [],
    addCommand: () => ({ command: "pnpm", args: ["add"] }),
    installCommand: ({ cwd }: { cwd: string }) => ({ command: "pnpm", args: ["install"], cwd }),
    afterInstallScript: "prepare",
};

/** A stand-in `host.processes` whose interactive runs exit with `exitCode`, recording each. */
export function fakeProcesses(exitCode = 0): { processes: unknown; ran: Array<{ command: string; args: readonly string[] }> } {
    const ran: Array<{ command: string; args: readonly string[] }> = [];

    return {
        ran,
        processes: {
            runInteractive: async (command: string, args: readonly string[]) => {
                ran.push({ command, args });

                return { exitCode, signal: null, durationMs: 0 };
            },
        },
    };
}

/** The names a config is found under, as the real loader tries them. */
const MAIN_NAMES = ["sous.config.ts", "sous.config.mts", "sous.config.js", "sous.config.mjs", "sous.config.jsonc", "sous.config.json", "sous.config.yaml", "sous.config.yml"];

/** A loader that finds config files by name and reads `.jsonc` and `.js` ones. */
export const fakeLoader: Pick<ConfigFilesLoader, "findMain" | "load"> = {
    findMain(sousDir) {
        const name = MAIN_NAMES.find((candidate) => fs.existsSync(path.join(sousDir, candidate)));

        return name === undefined ? undefined : path.join(sousDir, name);
    },

    async load(file) {
        if (file.endsWith(".js")) {
            const module = (await import(pathToFileURL(file).href)) as { config: unknown };

            return { kind: "module", path: file, format: "js", configure: () => {}, text: JSON.stringify(module.config) } as never;
        }

        const text = fs.readFileSync(file, "utf8");
        const data = JSON.parse(text.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n"));

        return { kind: "data", path: file, format: "jsonc", data, text } as never;
    },
};

/** A stand-in for `formats.lockfile`: reads any object, writes indented JSON with a newline. */
export const fakeLockfileFormat = {
    parse: (value: unknown) => value,
    stringify: (value: unknown) => `${JSON.stringify(value, null, 2)}\n`,
    empty: () => ({ formatVersion: 1, repos: {}, recipes: {} }),
};

/** Options for {@link initContext}. */
export interface InitContextOptions {
    /** The answers the prompter gives, in order; omitted means it cannot ask. */
    answers?: unknown[];
    /** What the `build` intent answers. */
    build?: Partial<BuildResult>;
    version?: string;
    /** Changes to the loader. */
    loader?: Partial<ConfigFilesLoader>;
    /** More services, such as a stand-in `git.runner`. */
    services?: Record<string, unknown>;
    /** The `package-manager` entities. */
    managers?: unknown[];
}

/** What the context saw. */
export interface InitRecorded {
    reporter: BufferedReporter;
    /** Every intent `ctx.run` was asked for. */
    runs: Array<{ intent: string; input: unknown }>;
    configChanged: number;
    /** How many times the config was refreshed, and the runs before each refresh. */
    refreshes: number[];
    asked: string[];
}

/** A `Context` for `init`. */
export function initContext(options: InitContextOptions = {}): { ctx: Context; recorded: InitRecorded } {
    const reporter = new BufferedReporter();
    const prompter = scriptedPrompter([...(options.answers ?? [])]);
    const recorded: InitRecorded = { reporter, runs: [], configChanged: 0, refreshes: [], asked: prompter.asked };
    const services: Record<string, unknown> = {
        "host.package": { identity: () => ({ name: "@sous-io/sous", version: options.version ?? "0.1.1", root: "/x", realRoot: "/x", bin: undefined }) },
        "host.gitignore": createGitignore(),
        "host.directories": createDirectories({
            entities: { list: () => [] } as never,
            sousHome: { paths: () => ({ root: "/nowhere-sous-home" }) } as never,
        }),
        "config-files.loader": { ...fakeLoader, ...options.loader },
        "formats.lockfile": fakeLockfileFormat,
        ...options.services,
    };
    const ctx = {
        plugin: "@sous-io/sous-plugin-init",
        reporter,
        prompter,
        services: { get: (name: string) => services[name], has: (name: string) => name in services },
        entities: { list: (kind: string) => (kind === "package-manager" ? (options.managers ?? []) : []) },
        project: undefined,
        cwd: process.cwd(),
        env: {},
        configChanged: () => void recorded.configChanged++,
        chain: { id: 1, intent: "init", parallel: false },
        refreshConfig: async () => void recorded.refreshes.push(recorded.runs.length),
        run: async (intent: string, input: unknown) => {
            recorded.runs.push({ intent, input });

            // init.hooks is this plugin's own intent, so it runs for real.
            if (intent === "init.hooks") {
                return hooksHandle(input as InitHooksInput, ctx);
            }

            return IntentOutputs.of({ ok: true, dryRun: false, watching: false, ...options.build });
        },
    } as unknown as Context;

    return { ctx, recorded };
}
