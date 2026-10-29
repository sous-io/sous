import { type InputError, isSousError, isSousErrorOfKind } from "@sous-io/plugin-api";
import type { Command } from "./command-tree.js";
import type { CliErrorView } from "./types.js";

/**
 * Turns an error into lines for standard error and an exit code (S6, `cli.errors`). Every message
 * starts with `Error: `; a sous error's details follow, indented. Input errors name the flag or
 * argument, not the input field. Exit codes: the error's own (1 by default, 2 for usage problems).
 */
export function viewError(error: unknown, options: { debug?: boolean; command?: Command } = {}): CliErrorView {
    if (isSousError(error)) {
        const details = isSousErrorOfKind(error, "input") && options.command ? inputDetails(error as InputError, options.command) : [...error.details];
        const lines = [`Error: ${error.message}`, ...details.map((line) => `  ${line}`)];

        if (options.debug && error.stack) {
            lines.push(...stackLines(error.stack));
        }

        return { lines, exitCode: error.exitCode };
    }

    const message = error instanceof Error ? error.message : String(error);
    const lines = [`Error: ${message}`];

    if (options.debug && error instanceof Error && error.stack) {
        lines.push(...stackLines(error.stack));
    }

    return { lines, exitCode: 1 };
}

function inputDetails(error: InputError, command: Command): string[] {
    return error.issues.map((issue) => {
        const field = issue.path.split(/[.[]/)[0] ?? "";
        const positional = command.positionals.find((spec) => spec.field === field);
        const flag = command.flags.find((spec) => spec.field === field);
        const rest = issue.path.slice(field.length);
        const where = positional ? `<${positional.name}>${rest}` : flag ? `--${flag.name}${rest}` : issue.path;

        return where ? `${where}: ${issue.message}` : issue.message;
    });
}

function stackLines(stack: string): string[] {
    return stack.split("\n").slice(1).map((line) => `  ${line.trim()}`);
}
