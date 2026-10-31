import { type InputError, isSousError, isSousErrorOfKind, SousError } from "@sous-io/plugin-api";
import type { Command } from "./command-tree.js";
import type { CliErrorView } from "./types.js";

/** An error taken apart: its message, the lines under it, and its exit code. */
export interface ErrorParts {
    readonly summary: string;
    /** The lines under the message (a sous error's details, then the stack with `debug`), unindented. */
    readonly details: readonly string[];
    readonly exitCode: number;
}

/** Takes an error apart for the reporter to draw: the message, the details under it and the exit code. */
export function describeError(error: unknown, options: { debug?: boolean; command?: Command } = {}): ErrorParts {
    if (isSousError(error)) {
        const details = isSousErrorOfKind(error, "input") && options.command ? inputDetails(error as InputError, options.command) : [...error.details];

        if (options.debug && error.stack) {
            details.push(...stackLines(error.stack));
        }

        return { summary: error.message, details, exitCode: error.exitCode };
    }

    const details = options.debug && error instanceof Error && error.stack ? stackLines(error.stack) : [];

    return { summary: error instanceof Error ? error.message : String(error), details, exitCode: 1 };
}

/**
 * The error to hand the reporter: the error itself, except an input error, which names the flags
 * and arguments of the command the input was for, not the input's field names. The cause chain is kept.
 */
export function errorForDisplay(error: unknown, command?: Command): Error {
    if (!(error instanceof Error)) {
        return new Error(String(error));
    }

    if (command && isSousErrorOfKind(error, "input")) {
        const input = error as InputError;
        const copy = new SousError(input.message, {
            details: inputDetails(input, command),
            exitCode: input.exitCode,
            ...(input.cause === undefined ? {} : { cause: input.cause }),
        });

        copy.stack = input.stack;

        return copy;
    }

    return error;
}

/**
 * Turns an error into lines for standard error and an exit code. Every message
 * starts with `Error: `; a sous error's details follow, indented. Input errors name the flag or
 * argument, not the input field. Exit codes: the error's own (1 by default, 2 for usage problems).
 */
export function viewError(error: unknown, options: { debug?: boolean; command?: Command } = {}): CliErrorView {
    const parts = describeError(error, options);

    return { lines: [`Error: ${parts.summary}`, ...parts.details.map((line) => `  ${line}`)], exitCode: parts.exitCode };
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
    return stack.split("\n").slice(1).map((line) => line.trim());
}
