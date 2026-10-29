import { type EngineHandle, type Environment, isLogLevel, type LogLevel, type Reporter, type SubmitOptions } from "@sous-io/plugin-api";
import type { CommandTree } from "./command-tree.js";
import { viewError } from "./errors.js";
import { globalSpecs } from "./globals.js";
import { renderHelp } from "./help.js";
import type { CliIo } from "./io.js";
import { parseLine } from "./parse.js";
import { canPrompt, TerminalPrompter } from "./terminal-prompter.js";
import { TerminalReporter } from "./terminal-reporter.js";
import { renderTimings } from "./views.js";
import { renderBanner } from "./views/banner.js";
import { showResult } from "./views/show.js";
import { colorEnabled, createStyle } from "./views/style.js";
import { listenForWatchKeys, startedWatching, WATCH_KEYS_HINT } from "./watch-keys.js";

/** What the CLI front end needs besides the engine. */
export interface CliRunOptions {
    readonly io: CliIo;
    readonly env: Environment;
}

/**
 * Runs one command line (S1, "Front Ends"): parses argv against the command tree, then shows help,
 * prints the version, or submits the intent as a chain with a terminal reporter and prompter and
 * prints its result. Errors become `Error: ` lines on standard error and an exit code.
 */
export async function runCommandLine(engine: EngineHandle, argv: readonly string[], options: CliRunOptions): Promise<void> {
    const { io, env } = options;
    let reporter: Reporter = new TerminalReporter(io.stderr, "info");
    let debug = false;

    engine.setReporter(reporter);

    try {
        const tree = engine.config.services.get("cli.commands") as CommandTree;
        const specs = globalSpecs(engine.config.entities.list("cli-global-argument"));
        const line = parseLine(versionArgv(argv, tree), tree, specs, engine.app.name);
        const level = thresholdOf(line.globals);

        debug = line.globals.debug === true;
        reporter = new TerminalReporter(io.stderr, level, createStyle(colorEnabled(io.stderr, env)));
        engine.setReporter(reporter);

        for (const warning of tree.warnings) {
            reporter.warning(warning);
        }

        switch (line.kind) {
            case "help":
                io.stdout.write(renderHelp(line.node, { appName: engine.app.name, globals: specs }));
                break;
            case "version":
                io.stdout.write(`v${engine.app.version}\n`);
                break;
            case "error":
                io.stderr.write(`Error: ${line.message}\n${line.details.map((detail) => `  ${detail}\n`).join("")}`);
                io.setExitCode(2);
                break;
            case "run": {
                const prompter = new TerminalPrompter(io.stdin, io.stderr, canPrompt(io, env, line.globals));
                const intent = line.command.intent;
                const submitOptions = { reporter, prompter, globals: line.globals };
                const show = async (result: unknown) => {
                    const shown = await showResult(intent, result, { entities: engine.config.entities, stdout: io.stdout, env, input: line.input, globals: line.globals });

                    if (shown.stdout) {
                        io.stdout.write(shown.stdout);
                    }

                    if (shown.stderr) {
                        io.stderr.write(shown.stderr);
                    }

                    if (shown.exitCode !== undefined && shown.exitCode !== 0) {
                        io.setExitCode(shown.exitCode);
                    }
                };
                const fail = (error: unknown) => {
                    const view = viewError(error, { debug, command: line.command });

                    io.stderr.write(`${view.lines.join("\n")}\n`);
                    io.setExitCode(view.exitCode);
                };

                if (io.stderr.isTTY === true && line.globals.json !== true && engine.config.entities.has("cli-view", intent)) {
                    io.stderr.write(renderBanner(createStyle(colorEnabled(io.stderr, env))));
                }

                try {
                    const result = await engine.submit({ intent, input: line.input }, submitOptions);

                    await show(result);

                    if (startedWatching(result)) {
                        await watchUntilStopped(engine, io, intent, line.input, submitOptions, show, fail);
                    }
                } catch (error) {
                    fail(error);
                }

                break;
            }
        }

        if (line.globals.timings === true) {
            io.stderr.write(renderTimings(engine.timings.entries()));
        }
    } catch (error) {
        const view = viewError(error, { debug });

        io.stderr.write(`${view.lines.join("\n")}\n`);
        io.setExitCode(view.exitCode);
    }
}

/**
 * `sous --version --verbose`, as before the refactor, runs the `version` intent with `--verbose`,
 * so it prints the package, platform and Node build too.
 */
function versionArgv(argv: readonly string[], tree: CommandTree): readonly string[] {
    if (argv[0] === "--version" && argv.length > 1 && argv.slice(1).every((token) => token === "--verbose") && tree.root.children.get("version")?.command) {
        return ["version", "--verbose"];
    }

    return argv;
}

/** The threshold `--debug` and `--log-level` ask for (C61); `--debug` means `--log-level debug`. */
export function thresholdOf(globals: Readonly<Record<string, unknown>>): LogLevel {
    if (globals.debug === true) {
        return "debug";
    }

    const level = globals["log-level"];

    return isLogLevel(level) ? level : "info";
}

/**
 * Watch mode's keys, while it runs (as before the refactor): Q or Ctrl+C stops it, and any other key
 * submits the command again without `--watch`, a full rebuild. Resolves when watch mode has stopped.
 */
async function watchUntilStopped(
    engine: EngineHandle,
    io: CliIo,
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

    io.stderr.write(`${WATCH_KEYS_HINT}\n`);

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

            io.stderr.write("Manual rebuild triggered.\n");
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
