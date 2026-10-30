import { type EngineHandle, type Environment, isLogLevel, isSousErrorOfKind, LogLevel, SousError, type ProjectInfo, type Reporter, type SubmitOptions } from "@sous-io/plugin-api";
import type { Command, CommandTree } from "./command-tree.js";
import { COMPLETE_COMMAND } from "./completion.js";
import { describeError } from "./errors.js";
import { globalSpecs } from "./globals.js";
import { renderHelp } from "./help.js";
import type { CliIo } from "./io.js";
import { parseLine } from "./parse.js";
import { canPrompt, TerminalPrompter, whyCannotPrompt } from "./terminal-prompter.js";
import { TerminalReporter } from "./terminal-reporter.js";
import { reportTimings } from "./views.js";
import { showResult } from "./views/show.js";
import { listenForWatchKeys, startedWatching, WATCH_KEYS_HINT } from "./watch-keys.js";

/** What the CLI front end needs besides the engine. */
export interface CliRunOptions {
    readonly io: CliIo;
    readonly env: Environment;
    /** The working directory chains get as `ctx.cwd`: the process's. Default: the engine's. */
    readonly cwd?: string;
    /** The project the engine serves now, for views that name it. */
    readonly project?: () => ProjectInfo | undefined;
}

/**
 * Runs one command line: parses argv against the command tree, then shows help,
 * prints the version, or submits the intent as a chain with a terminal reporter and prompter and
 * prints its result. Errors become `Error: ` lines on standard error and an exit code.
 */
export async function runCommandLine(engine: EngineHandle, argv: readonly string[], options: CliRunOptions): Promise<void> {
    const { io, env } = options;
    let reporter = new TerminalReporter({ stdout: io.stdout, stderr: io.stderr, threshold: LogLevel.Info, env });
    // `SOUS_DEBUG` asks for stack traces, as before the refactor, without changing the log level.
    let debug = debugRequested(env);

    engine.setReporter(reporter);

    try {
        const tree = engine.config.services.get("cli.commands") as CommandTree;
        const specs = globalSpecs(engine.config.entities.list("cli-global-argument"));
        const line = parseLine(versionArgv(argv, tree), tree, specs, engine.app.name);
        const level = thresholdOf(line.globals);
        // A background intent (`sous mcp`) owns standard output while it runs, so every message goes
        // to standard error, as under --json.
        const ownsStdout = line.kind === "run" && engine.intents.get(line.command.intent)?.definition.background === true;
        const json = line.globals.json === true || ownsStdout;

        debug = debug || line.globals.debug === true;
        reporter = new TerminalReporter({ stdout: io.stdout, stderr: io.stderr, threshold: level, env, json });
        engine.setReporter(reporter);

        for (const warning of tree.warnings) {
            reporter.warning(warning);
        }

        // A config that failed to build stops every command except an intent that can run
        // without it (`sous update`), as it did before the front end started.
        if (engine.configError !== undefined && !(line.kind === "run" && engine.intents.get(line.command.intent)?.definition.toleratesConfigErrors === true)) {
            throw engine.configError;
        }

        const help = (node: Parameters<typeof renderHelp>[0], where: LogLevel) =>
            renderHelp(node, { appName: engine.app.name, globals: specs, style: reporter.styleFor(where) });

        switch (line.kind) {
            case "help":
                reporter.text(help(line.node, LogLevel.Info));
                break;
            case "version":
                reporter.text(`v${engine.app.version}`);
                break;
            case "error": {
                reportError(reporter, new SousError(line.message, { details: line.details, exitCode: 2 }), { debug }, io);

                if (line.showHelp) {
                    reporter.text(`\n${help(line.node, LogLevel.Error)}`, LogLevel.Error);
                }

                break;
            }
            case "run": {
                const prompter = new TerminalPrompter(io.stdin, io.stderr, canPrompt(io, env, line.globals), whyCannotPrompt(io, env, line.globals));
                const intent = line.command.intent;
                const submitOptions = { reporter, prompter, globals: line.globals, ...(options.cwd === undefined ? {} : { cwd: options.cwd }) };
                // A background intent (`sous mcp`) owns standard output while it runs; its result is not printed.
                const background = engine.intents.get(intent)?.definition.background === true;
                const show = async (result: unknown) => {
                    const shown = await showResult(intent, result, {
                        entities: engine.config.entities,
                        reporter,
                        stdout: io.stdout,
                        input: line.input,
                        globals: line.globals,
                        project: options.project?.(),
                        projectName: projectNameOf(engine),
                        cwd: options.cwd,
                    });

                    reporter.finish();

                    if (shown.exitCode !== undefined && shown.exitCode !== 0) {
                        io.setExitCode(shown.exitCode);
                    }
                };
                const fail = (error: unknown) => {
                    reportError(reporter, error, { debug, command: line.command }, io);

                    // A question that could not be asked, or input the command could not take, is
                    // answered by the command's flags, so its help follows (as before the refactor).
                    if (wantsHelp(error)) {
                        reporter.text(`\n${help(line.node, LogLevel.Error)}`, LogLevel.Error);
                    }
                };

                if (io.stderr.isTTY === true && !json && engine.config.entities.has("cli-view", intent)) {
                    reporter.banner();
                }

                try {
                    const result = await engine.submit({ intent, input: line.input }, submitOptions);

                    if (!background) {
                        await show(result);
                    }

                    if (startedWatching(result)) {
                        await watchUntilStopped(engine, io, reporter, intent, line.input, submitOptions, show, fail);
                    }
                } catch (error) {
                    fail(error);
                }

                break;
            }
        }

        if (line.globals.timings === true) {
            reportTimings(reporter, engine.timings.entries());
        }
    } catch (error) {
        // With a broken config, its error is the one to show, whatever failed after it.
        reportError(reporter, engine.configError ?? error, { debug }, io);
    } finally {
        reporter.finish();
    }
}

/**
 * Whether a command line needs the built config: not when it asks for help or the version, or runs
 * an intent that declares `runsWithoutConfig` (shell completion). A line that does not parse
 * (a command only a later plugin adds, say) needs it.
 */
export function commandLineNeedsConfig(engine: EngineHandle, argv: readonly string[]): boolean {
    const tree = engine.config.services.get("cli.commands") as CommandTree;
    const specs = globalSpecs(engine.config.entities.list("cli-global-argument"));
    const line = parseLine(versionArgv(argv, tree), tree, specs, engine.app.name);

    switch (line.kind) {
        case "help":
        case "version":
            return false;
        case "run":
            return engine.intents.get(line.command.intent)?.definition.runsWithoutConfig !== true;
        default:
            return true;
    }
}

/** Reports an error as a problem (`Error: ` and what is under it) and sets the exit code. */
function reportError(reporter: Reporter, error: unknown, options: { debug?: boolean; command?: Command }, io: CliIo): void {
    const parts = describeError(error, { ...options, debug: false });

    reporter.problem(parts.summary, parts.details.length === 0 ? {} : { cause: parts.details.join("\n") }, LogLevel.Error);

    // Stack frames are shown exactly as given: wrapping would split a frame from its location.
    if (options.debug && error instanceof Error && error.stack) {
        reporter.text(error.stack.split("\n").slice(1).join("\n"), LogLevel.Error);
    }

    io.setExitCode(parts.exitCode);
}

/** Values of `SOUS_DEBUG` that mean "not set"; anything else asks for stack traces. */
const DEBUG_OFF = new Set(["", "0", "false", "no", "off"]);

/** True when `SOUS_DEBUG` is set to something other than an "off" value. */
export function debugRequested(env: Environment): boolean {
    const raw = env.SOUS_DEBUG;

    return raw !== undefined && !DEBUG_OFF.has(raw.trim().toLowerCase());
}

/** True for the errors the command's own help helps with: bad input, and a question no one could answer. */
function wantsHelp(error: unknown): boolean {
    return isSousErrorOfKind(error, "input") || isSousErrorOfKind(error, "non-interactive");
}

/**
 * `sous --version --verbose`, as before the refactor, runs the `version` intent with `--verbose`,
 * so it prints the package, platform and Node build too.
 */
function versionArgv(argv: readonly string[], tree: CommandTree): readonly string[] {
    // The completion scripts pass the words typed so far, flags included, as plain arguments.
    if (argv[0] === COMPLETE_COMMAND) {
        return [COMPLETE_COMMAND, "--", ...argv.slice(1)];
    }

    if (argv[0] === "--version" && argv.length > 1 && argv.slice(1).every((token) => token === "--verbose") && tree.root.children.get("version")?.command) {
        return ["version", "--verbose"];
    }

    return argv;
}

/** The threshold `--debug` and `--log-level` ask for; `--debug` means `--log-level debug`. */
export function thresholdOf(globals: Readonly<Record<string, unknown>>): LogLevel {
    if (globals.debug === true) {
        return LogLevel.Debug;
    }

    const level = globals["log-level"];

    return isLogLevel(level) ? level : LogLevel.Info;
}

/**
 * Watch mode's keys, while it runs (as before the refactor): Q or Ctrl+C stops it, and any other key
 * submits the command again without `--watch`, a full rebuild. Resolves when watch mode has stopped.
 */
async function watchUntilStopped(
    engine: EngineHandle,
    io: CliIo,
    reporter: Reporter,
    intent: string,
    input: Readonly<Record<string, unknown>>,
    submitOptions: SubmitOptions,
    show: (result: unknown) => Promise<void>,
    fail: (error: unknown) => void,
): Promise<void> {
    if (io.stdin.isTTY !== true) {
        await engine.whenBackgroundIntentsReturn();

        return;
    }

    reporter.note(WATCH_KEYS_HINT);

    let rebuilding: Promise<void> | undefined;
    const stop = listenForWatchKeys(io.stdin, {
        quit: () => {
            stop();
            io.interrupt?.();
        },
        rebuild: () => {
            if (rebuilding) {
                return;
            }

            reporter.notice("Manual rebuild triggered.");
            rebuilding = engine
                .submit({ intent, input: { ...input, watch: false } }, submitOptions)
                .then(show, fail)
                .finally(() => {
                    rebuilding = undefined;
                });
        },
    });

    try {
        await engine.whenBackgroundIntentsReturn();
        await rebuilding;
    } finally {
        stop();
    }
}

/** The config's `name`, when it is a string. */
function projectNameOf(engine: EngineHandle): string | undefined {
    const name = engine.config.get("name");

    return typeof name === "string" && name.trim() !== "" ? name : undefined;
}
