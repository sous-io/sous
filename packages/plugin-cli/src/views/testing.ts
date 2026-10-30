/**
 * Runs a view against a real {@link TerminalReporter} writing to strings, for tests: what a view
 * shows is checked as the text a terminal would get, colors off unless asked for.
 */

import type { LogLevel, ProjectInfo } from "@sous-io/plugin-api";
import { TerminalReporter } from "../terminal-reporter.js";
import type { CliViewContext, CliViewEntity } from "../types.js";

/** A stream that keeps what is written to it. */
export class CaptureStream {
    text = "";

    constructor(
        readonly isTTY = false,
        readonly columns?: number,
    ) {}

    write(chunk: string): boolean {
        this.text += chunk;

        return true;
    }
}

/** What {@link captureView} runs the view with. Everything is optional. */
export interface CaptureOptions {
    readonly intent?: string;
    readonly input?: Readonly<Record<string, unknown>>;
    readonly globals?: Readonly<Record<string, unknown>>;
    readonly project?: ProjectInfo;
    readonly projectName?: string;
    readonly cwd?: string;
    /** The least severe level shown. Default `info`. */
    readonly threshold?: LogLevel;
    /** Whether colors are on. Default off. */
    readonly color?: boolean;
    /** The width the output is laid out in. Default 100. */
    readonly columns?: number;
    /** What `view.show(...)` does for a nested result. Default: nothing. */
    readonly show?: CliViewContext["show"];
}

/** What a view showed: each stream's text, and the exit code it asked for. */
export interface CapturedView {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode?: number;
}

/**
 * Runs one view's `render` and returns what it showed.
 *
 * ```ts
 * const shown = await captureView(views["repo.list"]!, { repositories: [] });
 * expect(shown.stdout).toContain("No repositories are added.");
 * ```
 */
export async function captureView(render: CliViewEntity["render"], result: unknown, options: CaptureOptions = {}): Promise<CapturedView> {
    const stdout = new CaptureStream();
    const stderr = new CaptureStream();
    const reporter = new TerminalReporter({
        stdout,
        stderr,
        threshold: options.threshold ?? "info",
        color: options.color ?? false,
        columns: options.columns ?? 100,
    });
    const context: CliViewContext = {
        intent: options.intent ?? "test",
        input: options.input ?? {},
        globals: options.globals ?? {},
        reporter,
        show: options.show ?? (async () => {}),
        ...(options.project === undefined ? {} : { project: options.project }),
        ...(options.projectName === undefined ? {} : { projectName: options.projectName }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    };
    const output = await render(result, context);

    reporter.finish();

    return { stdout: stdout.text, stderr: stderr.text, ...(output?.exitCode === undefined ? {} : { exitCode: output.exitCode }) };
}
