import { createInterface, type Interface } from "node:readline";
import {
    type ChoiceQuestion,
    type ConfirmQuestion,
    NonInteractiveError,
    type Prompter,
    type QuestionBase,
    type ValueQuestion,
} from "@sous-io/plugin-api";
import type { InputStream, OutputStream } from "./io.js";

/** A terminal's standard input, which can turn its echo off. */
type RawInput = InputStream & { setRawMode(mode: boolean): unknown };

/**
 * The CLI's prompter. It asks on standard error and reads standard input, and only when it may
 *: otherwise every question fails with a `NonInteractiveError` naming the flag that answers it.
 */
export class TerminalPrompter implements Prompter {
    private reader: Interface | undefined;
    private readonly lines: string[] = [];
    private readonly waiting: Array<(line: string | undefined) => void> = [];
    private closed = false;

    constructor(
        private readonly input: InputStream,
        private readonly output: OutputStream,
        readonly interactive: boolean,
        /** Why this run cannot ask, quoted in the error a question raises (see {@link whyCannotPrompt}). */
        private readonly reason?: string,
    ) {}

    async askValue(question: ValueQuestion): Promise<string> {
        this.refuseUnlessInteractive(question);

        for (;;) {
            const suffix = question.default !== undefined && question.secret !== true ? ` (${question.default})` : "";
            const answer = (await this.ask(`${question.message}${suffix} `, question)).trim() || question.default || "";
            const problem = question.validate?.(answer);

            if (!problem) {
                return answer;
            }

            this.output.write(`${problem}\n`);
        }
    }

    async askChoice<T>(question: ChoiceQuestion<T>): Promise<T> {
        this.refuseUnlessInteractive(question);

        const lines = question.choices.map((choice, index) => `  ${index + 1}. ${choice.label}${choice.description ? `: ${choice.description}` : ""}`);

        this.output.write(`${question.message}\n${lines.join("\n")}\n`);

        for (;;) {
            const fallback = question.defaultIndex !== undefined ? ` (${question.defaultIndex + 1})` : "";
            const answer = (await this.ask(`Pick a number${fallback}: `, question)).trim();
            const index = answer === "" && question.defaultIndex !== undefined ? question.defaultIndex : Number(answer) - 1;
            const choice = question.choices[index];

            if (Number.isInteger(index) && choice) {
                return choice.value;
            }

            this.output.write(`Pick a number from 1 to ${question.choices.length}.\n`);
        }
    }

    async confirm(question: ConfirmQuestion): Promise<boolean> {
        this.refuseUnlessInteractive(question);

        const hint = question.default === true ? "[Y/n]" : question.default === false ? "[y/N]" : "[y/n]";

        for (;;) {
            const answer = (await this.ask(`${question.message} ${hint} `, question)).trim().toLowerCase();

            if (answer === "" && question.default !== undefined) {
                return question.default;
            }

            if (answer === "y" || answer === "yes") {
                return true;
            }

            if (answer === "n" || answer === "no") {
                return false;
            }

            this.output.write("Answer yes or no.\n");
        }
    }

    private refuseUnlessInteractive(question: QuestionBase): void {
        if (!this.interactive) {
            throw new NonInteractiveError(question.message, question.answeredBy, this.reason === undefined ? {} : { details: [`Why: ${this.reason}.`] });
        }
    }

    /** Writes the prompt and waits for the next line; one reader serves every question. */
    private ask(prompt: string, question: QuestionBase & { secret?: boolean }): Promise<string> {
        if (question.secret === true && this.input.isTTY === true && typeof (this.input as RawInput).setRawMode === "function" && this.lines.length === 0) {
            return this.askSecret(prompt, question);
        }

        this.output.write(prompt);

        const buffered = this.lines.shift();

        if (buffered !== undefined) {
            return Promise.resolve(buffered);
        }

        const ended = () => new NonInteractiveError(question.message, question.answeredBy, { details: ["Standard input ended before it was answered."] });

        if (this.closed) {
            return Promise.reject(ended());
        }

        this.reader ??= this.openReader();
        this.reader.resume();

        return new Promise((resolve, reject) => this.waiting.push((line) => (line === undefined ? reject(ended()) : resolve(line))));
    }

    /**
     * Reads a secret answer from a terminal with its echo off, showing a `*` for each character typed,
     * as the CLI did before the refactor: `? What is the token? ******`. Backspace removes the last
     * character; Ctrl+C or Ctrl+D stops the question.
     */
    private askSecret(prompt: string, question: QuestionBase): Promise<string> {
        const input = this.input as RawInput;

        this.output.write(prompt);
        this.reader?.pause();
        input.setRawMode(true);
        input.resume();

        return new Promise((resolve, reject) => {
            let value = "";
            const finish = (error?: Error) => {
                input.off("data", onData);
                input.setRawMode(false);
                input.pause();
                this.output.write("\n");

                if (error) {
                    reject(error);
                } else {
                    resolve(value);
                }
            };
            const onData = (chunk: Buffer | string) => {
                for (const char of chunk.toString()) {
                    if (char === "\r" || char === "\n") {
                        finish();

                        return;
                    }

                    if (char === "\u0003" || char === "\u0004") {
                        finish(new NonInteractiveError(question.message, question.answeredBy, { details: ["The question was stopped before it was answered."] }));

                        return;
                    }

                    if (char === "\u007f" || char === "\b") {
                        if (value.length > 0) {
                            value = value.slice(0, -1);
                            this.output.write("\b \b");
                        }

                        continue;
                    }

                    value += char;
                    this.output.write("*");
                }
            };

            input.on("data", onData);
        });
    }

    private openReader(): Interface {
        const reader = createInterface({ input: this.input, terminal: false });

        reader.on("line", (line) => {
            const next = this.waiting.shift();

            if (next) {
                next(line);
            } else {
                this.lines.push(line);
            }

            if (this.waiting.length === 0) {
                reader.pause();
            }
        });
        reader.on("close", () => {
            this.closed = true;

            for (const next of this.waiting.splice(0)) {
                next(undefined);
            }
        });

        return reader;
    }
}

/**
 * Whether this run may ask questions: standard input and output are terminals, no CI variable is set,
 * and `--non-interactive` was not passed (about-cli-command-design, "Never prompt without a terminal").
 */
export function canPrompt(
    io: { stdin: { isTTY?: boolean }; stdout: { isTTY?: boolean } },
    env: Readonly<Record<string, string | undefined>>,
    globals: Readonly<Record<string, unknown>> = {},
): boolean {
    return whyCannotPrompt(io, env, globals) === undefined;
}

/**
 * Why this run cannot ask questions, as a plain phrase, or `undefined` when it can. The error a
 * question raises quotes it, as the CLI before 1.0 did: "sous cannot ask" is baffling on its own
 * when only `CI=1` in the shell made it true.
 *
 * ```ts
 * whyCannotPrompt(io, { CI: "true" });   // "the 'CI' environment variable is set to 'true'"
 * ```
 */
export function whyCannotPrompt(
    io: { stdin: { isTTY?: boolean }; stdout: { isTTY?: boolean } },
    env: Readonly<Record<string, string | undefined>>,
    globals: Readonly<Record<string, unknown>> = {},
): string | undefined {
    if (globals["non-interactive"] === true) {
        return "the '--non-interactive' flag was passed";
    }

    const ci = env.CI;

    if (ci !== undefined && !["", "0", "false"].includes(ci.trim().toLowerCase())) {
        return `the 'CI' environment variable is set to '${ci}'`;
    }

    const stdin = io.stdin.isTTY === true;
    const stdout = io.stdout.isTTY === true;

    if (!stdin && !stdout) {
        return "neither input nor output is a terminal";
    }

    if (!stdin) {
        return "input is not a terminal";
    }

    return stdout ? undefined : "output is not a terminal";
}
