import type { EntityReader, ProjectInfo, Reporter } from "@sous-io/plugin-api";
import type { OutputStream } from "../io.js";
import type { CliViewContext, CliViewEntity } from "../types.js";

/** What showing a result needs. */
export interface ShowOptions {
    readonly entities: EntityReader;
    /** Where the run's messages go; a view shows its result through it. */
    readonly reporter: Reporter;
    /** Where `--json` prints the result. */
    readonly stdout: OutputStream;
    readonly input: Readonly<Record<string, unknown>>;
    readonly globals: Readonly<Record<string, unknown>>;
    /** The project the command ran on, when there is one. */
    readonly project?: ProjectInfo | undefined;
    /** The project's name, as its config's `name` gives it. */
    readonly projectName?: string | undefined;
    /** The directory the command was run from. */
    readonly cwd?: string | undefined;
}

/** What showing a result decided besides the output. */
export interface ShownResult {
    readonly exitCode?: number;
}

/**
 * Shows an intent's result: as JSON on standard output with `--json`, through the intent's
 * `cli-view` when it has one, and otherwise as {@link reportResult} does.
 */
export async function showResult(intent: string, result: unknown, options: ShowOptions): Promise<ShownResult> {
    if (options.globals.json === true) {
        if (result !== undefined) {
            options.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        }

        return {};
    }

    const view = options.entities.get("cli-view", intent) as CliViewEntity | undefined;

    if (!view) {
        reportResult(options.reporter, result);

        return {};
    }

    const output = await view.render(result, viewContext(intent, options));

    return output?.exitCode === undefined ? {} : { exitCode: output.exitCode };
}

/** The context a view gets. */
export function viewContext(intent: string, options: ShowOptions): CliViewContext {
    return {
        intent,
        input: options.input,
        globals: options.globals,
        reporter: options.reporter,
        ...(options.project === undefined ? {} : { project: options.project }),
        ...(options.projectName === undefined ? {} : { projectName: options.projectName }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        show: async (other, result, input = {}) => {
            await showResult(other, result, { ...options, input, globals: { ...options.globals, json: false } });
        },
    };
}

/**
 * How a result with no view is reported: nothing for `undefined` or `null`, text as it is, a
 * number, boolean or bigint as text, anything else as data.
 */
export function reportResult(reporter: Reporter, result: unknown): void {
    if (result === undefined || result === null) {
        return;
    }

    if (typeof result === "string") {
        reporter.text(result);
    } else if (typeof result === "number" || typeof result === "boolean" || typeof result === "bigint") {
        reporter.text(String(result));
    } else {
        reporter.data(result);
    }
}
