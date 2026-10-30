import type { EntityReader, Environment, ProjectInfo } from "@sous-io/plugin-api";
import type { OutputStream } from "../io.js";
import type { CliViewContext, CliViewEntity, CliViewOutput } from "../types.js";
import { Printer } from "./printer.js";
import { colorEnabled, createStyle } from "./style.js";
import { terminalColumns } from "./text.js";

/** What showing a result writes. */
export interface ShownResult {
    readonly stdout?: string;
    readonly stderr?: string;
    readonly exitCode?: number;
}

/** What {@link showResult} needs. */
export interface ShowOptions {
    readonly entities: EntityReader;
    readonly stdout: OutputStream & { readonly columns?: number };
    readonly env: Environment;
    readonly input: Readonly<Record<string, unknown>>;
    readonly globals: Readonly<Record<string, unknown>>;
    /** The project the command ran on, when there is one. */
    readonly project?: ProjectInfo;
    /** The project's name, as its config's `name` gives it. */
    readonly projectName?: string;
    /** The directory the command was run from. */
    readonly cwd?: string;
}

/**
 * Shows an intent's result: as JSON with `--json`, through the intent's `cli-view` when it has one,
 * and otherwise as {@link renderResult} does.
 */
export async function showResult(intent: string, result: unknown, options: ShowOptions): Promise<ShownResult> {
    if (options.globals.json === true) {
        return result === undefined ? {} : { stdout: `${JSON.stringify(result, null, 2)}\n` };
    }

    const view = options.entities.get("cli-view", intent) as CliViewEntity | undefined;

    if (!view) {
        return { stdout: renderResult(result) ?? "" };
    }

    return normalize(await view.render(result, viewContext(intent, options)));
}

/** The context a view gets. */
export function viewContext(intent: string, options: ShowOptions): CliViewContext {
    const style = createStyle(colorEnabled(options.stdout, options.env));
    const isTTY = options.stdout.isTTY === true;
    const columns = isTTY ? terminalColumns(options.stdout) : terminalColumns(undefined);

    return {
        intent,
        input: options.input,
        globals: options.globals,
        style,
        columns,
        isTTY,
        project: options.project,
        projectName: options.projectName,
        cwd: options.cwd,
        printer: () => new Printer(style, columns, isTTY),
        render: async (other, result, input = {}) => {
            const shown = await showResult(other, result, { ...options, input, globals: { ...options.globals, json: false } });

            return shown.stdout ?? "";
        },
    };
}

function normalize(output: CliViewOutput): ShownResult {
    if (output === undefined || output === null) {
        return {};
    }

    if (typeof output === "string") {
        return { stdout: output === "" || output.endsWith("\n") ? output : `${output}\n` };
    }

    return output;
}

/**
 * How a result with no view is printed: nothing for `undefined` or `null`, text as it is, anything
 * else as JSON.
 */
export function renderResult(result: unknown): string | undefined {
    if (result === undefined || result === null) {
        return undefined;
    }

    if (typeof result === "string") {
        return result.endsWith("\n") ? result : `${result}\n`;
    }

    if (typeof result === "number" || typeof result === "boolean" || typeof result === "bigint") {
        return `${String(result)}\n`;
    }

    return `${JSON.stringify(result, null, 2)}\n`;
}
