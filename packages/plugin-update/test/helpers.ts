/**
 * Stand-ins shared by the tests: package-manager entities that plan the commands the real
 * plugins plan, and a context whose services record instead of running anything. No test runs a
 * real install.
 */

import { BufferedReporter, type Context, type Prompter, scriptedPrompter, type ServiceContext } from "@sous-io/plugin-api";
import type { HostHttp, HostProcesses, InteractiveProcessOptions, InteractiveProcessResult } from "@sous-io/plugin-host/types";
import type {
    InstalledPackage,
    InstallScope,
    PackageManagerDetection,
    PackageManagerEntity,
} from "../src/types.js";

/** What a stand-in manager knows. */
export interface FakeManagerOptions {
    id: string;
    /** What `detect` answers for any directory, or per directory. */
    detect?: PackageManagerDetection | undefined | ((directory: string) => PackageManagerDetection | undefined);
    project?: (directory: string) => InstalledPackage[];
    global?: InstalledPackage[];
    /** Whether it can install globally. Default true. */
    canInstallGlobally?: boolean;
}

/** A manager that plans the commands npm, pnpm and Yarn plan. */
export function fakeManager(options: FakeManagerOptions): PackageManagerEntity {
    const { id } = options;
    const manager: PackageManagerEntity = {
        id,
        async detect(directory) {
            return typeof options.detect === "function" ? options.detect(directory) : options.detect;
        },
        async installed(scope: InstallScope, projectRoot) {
            return scope === "global" ? (options.global ?? []) : (options.project?.(projectRoot ?? "") ?? []);
        },
        addCommand(specs, add) {
            const flags = add.section === "devDependencies" ? ["-D", "-E"] : ["-E"];
            const root = add.workspaceRoot && id === "pnpm" ? ["-w"] : [];

            return { command: id, args: [id === "npm" ? "i" : "add", ...flags, ...root, ...specs], cwd: add.cwd };
        },
    };

    if (options.canInstallGlobally !== false) {
        manager.globalInstallCommand = (specs) => ({ command: id, args: [id === "npm" ? "i" : "add", "-g", ...specs] });
    }

    return manager;
}

/** One installed package. */
export function installedPackage(overrides: Partial<InstalledPackage> & { location: string }): InstalledPackage {
    return {
        name: "@sous-io/sous",
        version: "0.2.30",
        realPath: overrides.location,
        isSousPlugin: false,
        ...overrides,
    };
}

/** The `ServiceContext` the entity methods get, enough for the code under test. */
export function serviceContext(managers: PackageManagerEntity[]): ServiceContext {
    return {
        plugin: "@sous-io/plugin-update",
        config: { get: () => undefined },
        services: { get: () => undefined, has: () => false },
        entities: { list: () => managers, get: () => undefined, has: () => false, describe: () => [], kinds: () => [] },
        project: undefined,
        env: {},
    } as unknown as ServiceContext;
}

/** What a recording context saw. */
export interface Recorded {
    /** Every interactive command, as typed. */
    commands: string[];
    /** The directory and environment each ran with. */
    runs: Array<{ command: string; args: readonly string[]; cwd?: string; env?: Readonly<Record<string, string | undefined>>; windowsShell?: boolean }>;
    reporter: BufferedReporter;
}

/** Options for {@link recordingContext}. */
export interface RecordingOptions {
    managers: PackageManagerEntity[];
    /** The registry's answer body, or a status. */
    registry?: { status?: number; body?: string };
    /** The error of a failed config build, as the engine would hold it. */
    configError?: unknown;
    /** The answers the prompter gives, in order; omitted means it cannot ask. */
    answers?: unknown[];
    /** The exit code each command gives, in order; default 0. */
    exitCodes?: number[];
    ownRoot?: string;
    project?: Context["project"];
    env?: Context["env"];
    /** The intents the context's `run` forwards to. */
    onRun?: (intent: string, input: unknown) => unknown;
}

/** A `Context` whose services answer from the options and record what they were asked. */
export function recordingContext(options: RecordingOptions): { ctx: Context; recorded: Recorded; prompter: Prompter & { asked: string[] } } {
    const recorded: Recorded = { commands: [], runs: [], reporter: new BufferedReporter() };
    const exitCodes = [...(options.exitCodes ?? [])];
    const prompter = scriptedPrompter([...(options.answers ?? [])]);
    const processes: Pick<HostProcesses, "runInteractive"> = {
        async runInteractive(command: string, args: readonly string[], run?: InteractiveProcessOptions): Promise<InteractiveProcessResult> {
            recorded.commands.push([command, ...args].join(" "));
            recorded.runs.push({
                command,
                args,
                ...(run?.cwd === undefined ? {} : { cwd: run.cwd }),
                ...(run?.env === undefined ? {} : { env: run.env }),
                ...(run?.windowsShell === undefined ? {} : { windowsShell: run.windowsShell }),
            });

            return { exitCode: exitCodes.shift() ?? 0, signal: null, durationMs: 1 };
        },
    };
    const http = {
        async get() {
            const status = options.registry?.status ?? 200;

            return { status, statusText: status === 200 ? "OK" : "Failed", text: async () => options.registry?.body ?? "{}" };
        },
    } as unknown as HostHttp;
    const services: Record<string, unknown> = {
        "host.processes": processes,
        "host.http": http,
        "host.package": { identity: () => ({ name: "@sous-io/sous", version: "0.2.30", root: options.ownRoot ?? "/nowhere", realRoot: options.ownRoot ?? "/nowhere", bin: undefined }) },
    };
    const ctx = {
        plugin: "@sous-io/plugin-update",
        config: { get: () => undefined },
        services: { get: (name: string) => services[name], has: (name: string) => name in services },
        entities: { list: () => options.managers, get: () => undefined, has: () => false, describe: () => [], kinds: () => [] },
        reporter: recorded.reporter,
        prompter,
        project: options.project,
        env: options.env ?? {},
        // As the CLI gives it: the process's working directory, which the tests move into the project.
        get cwd() {
            return process.cwd();
        },
        run: async (intent: string, input: unknown) => options.onRun?.(intent, input),
        engine: { configError: options.configError },
    } as unknown as Context;

    return { ctx, recorded, prompter };
}
