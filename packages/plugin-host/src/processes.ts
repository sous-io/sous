/**
 * `host.processes`: the one owner of `spawn` (S6). Every run is timed; the engine also times each
 * service call.
 */

import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { constants, existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { SousError, type Environment } from "@sous-io/plugin-api";
import type {
    HostProcesses,
    InteractiveProcessOptions,
    InteractiveProcessResult,
    ProcessOptions,
    ProcessResult,
} from "./types.js";

/** The exit code given to a command that could not be started (the shell's own "not found"). */
export const NOT_FOUND_EXIT_CODE = 127;

/** A subprocess failed: it exited non-zero, or ran out of time. Holds the whole result. */
export class ProcessError extends SousError {
    /** What the subprocess gave back. */
    readonly result: ProcessResult;

    constructor(result: ProcessResult) {
        const label = [result.command, ...result.args].join(" ");
        const how = result.timedOut
            ? `did not finish in time and was stopped`
            : result.exitCode === null
              ? `was ended by the signal ${result.signal}`
              : `failed with exit code ${result.exitCode}`;
        const said = (result.stderr.trim() || result.stdout.trim()).split("\n").filter((line) => line.length > 0);

        super(`The command '${label}' ${how}.`, { details: said });
        this.result = result;
    }
}

/** What a process needs from the engine. */
export interface ProcessDeps {
    /** The environment commands get when the caller names none. */
    env: Environment;
}

/** Drops the variables whose value is `undefined`, which `spawn` would write as the text "undefined". */
function cleanEnvironment(env: Environment): Record<string, string> {
    const clean: Record<string, string> = {};

    for (const [name, value] of Object.entries(env)) {
        if (value !== undefined) {
            clean[name] = value;
        }
    }

    return clean;
}

/** Builds a result, and the message a command that could not start leaves in `stderr`. */
function failedToStart(command: string, args: readonly string[], error: Error, startedAt: number, cwd?: string): ProcessResult {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    // Node reports a missing working directory the same way as a missing command.
    const reason =
        missing && cwd !== undefined && !existsSync(cwd)
            ? `The directory ${cwd} does not exist`
            : missing
              ? `${command} is not installed, or is not on your PATH`
              : error.message;

    return {
        command,
        args,
        exitCode: NOT_FOUND_EXIT_CODE,
        signal: null,
        stdout: "",
        stderr: reason,
        durationMs: performance.now() - startedAt,
        timedOut: false,
    };
}

/** Throws when the caller asked for failures to throw and the run failed. */
function checked(result: ProcessResult, options: ProcessOptions): ProcessResult {
    if (options.reject === true && (result.exitCode !== 0 || result.timedOut)) {
        throw new ProcessError(result);
    }

    return result;
}

/** The result of a synchronous spawn, in the shape of an async one. */
function fromSync(command: string, args: readonly string[], raw: SpawnSyncReturns<string>, startedAt: number, cwd?: string): ProcessResult {
    const error = raw.error as NodeJS.ErrnoException | undefined;

    if (error !== undefined && error.code !== "ETIMEDOUT") {
        return failedToStart(command, args, error, startedAt, cwd);
    }

    return {
        command,
        args,
        exitCode: raw.status,
        signal: raw.signal,
        stdout: raw.stdout ?? "",
        stderr: raw.stderr ?? "",
        durationMs: performance.now() - startedAt,
        timedOut: error?.code === "ETIMEDOUT",
    };
}

/** The directories on `PATH`, and the extensions a command may carry on Windows. */
function searchPlaces(env: Environment): { directories: string[]; extensions: string[] } {
    const windows = process.platform === "win32";
    const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
    const directories = (env[key] ?? "").split(path.delimiter).filter((entry) => entry.length > 0);
    const extensions = windows ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter((entry) => entry.length > 0)] : [""];

    return { directories, extensions };
}

/** Whether a path is a file the user may run. */
async function isExecutable(file: string): Promise<boolean> {
    try {
        const stat = await fs.stat(file);

        if (!stat.isFile()) {
            return false;
        }

        await fs.access(file, constants.X_OK);

        return true;
    } catch {
        return false;
    }
}

/** Makes the `host.processes` service. */
export function createProcesses(deps: ProcessDeps): HostProcesses {
    const environmentOf = (options: { env?: Environment }): Record<string, string> => cleanEnvironment(options.env ?? deps.env);

    return {
        run(command, args, options = {}) {
            const startedAt = performance.now();

            return new Promise<ProcessResult>((resolve, reject) => {
                const finish = (result: ProcessResult): void => {
                    try {
                        resolve(checked(result, options));
                    } catch (error) {
                        reject(error);
                    }
                };

                const child = spawn(command, [...args], {
                    cwd: options.cwd,
                    env: environmentOf(options),
                    stdio: ["pipe", "pipe", "pipe"],
                    signal: options.signal,
                });
                let stdout = "";
                let stderr = "";
                let timedOut = false;
                let done = false;
                const timer =
                    options.timeoutMs === undefined
                        ? undefined
                        : setTimeout(() => {
                              timedOut = true;
                              child.kill("SIGKILL");
                          }, options.timeoutMs);

                const end = (result: ProcessResult): void => {
                    if (!done) {
                        done = true;
                        clearTimeout(timer);
                        finish(result);
                    }
                };

                child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
                child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
                child.stdin.on("error", () => {});
                child.on("error", (error) => {
                    // An abort is followed by `close`, which reports it.
                    if ((error as NodeJS.ErrnoException).code !== "ABORT_ERR") {
                        end({ ...failedToStart(command, args, error, startedAt, options.cwd), stdout });
                    }
                });
                child.on("close", (exitCode, signal) => {
                    end({ command, args, exitCode, signal, stdout, stderr, durationMs: performance.now() - startedAt, timedOut });
                });

                child.stdin.end(options.input);
            });
        },

        runSync(command, args, options = {}) {
            const startedAt = performance.now();
            const raw = spawnSync(command, [...args], {
                cwd: options.cwd,
                env: environmentOf(options),
                input: options.input,
                encoding: "utf8",
                timeout: options.timeoutMs,
                killSignal: "SIGKILL",
            });

            return checked(fromSync(command, args, raw, startedAt, options.cwd), options);
        },

        runInteractive(command, args, options: InteractiveProcessOptions = {}) {
            const startedAt = performance.now();

            return new Promise<InteractiveProcessResult>((resolve) => {
                const child = spawn(command, [...args], {
                    cwd: options.cwd,
                    env: environmentOf(options),
                    stdio: "inherit",
                    signal: options.signal,
                });

                child.on("error", () => resolve({ exitCode: NOT_FOUND_EXIT_CODE, signal: null, durationMs: performance.now() - startedAt }));
                child.on("close", (exitCode, signal) => resolve({ exitCode, signal, durationMs: performance.now() - startedAt }));
            });
        },

        async which(command, env = deps.env) {
            const { directories, extensions } = searchPlaces(env);
            const candidates = path.isAbsolute(command) || command.includes("/") ? [command] : directories.map((directory) => path.join(directory, command));

            for (const candidate of candidates) {
                for (const extension of extensions) {
                    if (await isExecutable(candidate + extension)) {
                        return candidate + extension;
                    }
                }
            }

            return undefined;
        },
    };
}
