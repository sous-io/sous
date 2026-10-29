import { type EngineHandle, type Environment, isLogLevel, type LogLevel, type Reporter } from "@sous-io/plugin-api";
import type { CommandTree } from "./command-tree.js";
import { viewError } from "./errors.js";
import { globalSpecs } from "./globals.js";
import { renderHelp } from "./help.js";
import type { CliIo } from "./io.js";
import { parseLine } from "./parse.js";
import { canPrompt, TerminalPrompter } from "./terminal-prompter.js";
import { TerminalReporter } from "./terminal-reporter.js";
import { renderResult, renderTimings } from "./views.js";

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
        const line = parseLine(argv, tree, specs, engine.app.name);
        const level = thresholdOf(line.globals);

        debug = line.globals.debug === true;
        reporter = new TerminalReporter(io.stderr, level);
        engine.setReporter(reporter);

        for (const warning of tree.warnings) {
            reporter.warning(warning);
        }

        switch (line.kind) {
            case "help":
                io.stdout.write(renderHelp(line.node, { appName: engine.app.name, globals: specs }));
                break;
            case "version":
                io.stdout.write(`${engine.app.version}\n`);
                break;
            case "error":
                io.stderr.write(`Error: ${line.message}\n${line.details.map((detail) => `  ${detail}\n`).join("")}`);
                io.setExitCode(2);
                break;
            case "run": {
                const prompter = new TerminalPrompter(io.stdin, io.stderr, canPrompt(io, env, line.globals));

                try {
                    const result = await engine.submit({ intent: line.command.intent, input: line.input }, { reporter, prompter, globals: line.globals });
                    const text = renderResult(result);

                    if (text !== undefined) {
                        io.stdout.write(text);
                    }
                } catch (error) {
                    const view = viewError(error, { debug, command: line.command });

                    io.stderr.write(`${view.lines.join("\n")}\n`);
                    io.setExitCode(view.exitCode);
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

/** The threshold `--debug` and `--log-level` ask for (C61); `--debug` means `--log-level debug`. */
export function thresholdOf(globals: Readonly<Record<string, unknown>>): LogLevel {
    if (globals.debug === true) {
        return "debug";
    }

    const level = globals["log-level"];

    return isLogLevel(level) ? level : "info";
}
