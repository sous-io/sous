import { createInterface } from "node:readline/promises";
import {
    type ChoiceQuestion,
    type ConfirmQuestion,
    NonInteractiveError,
    type Prompter,
    type QuestionBase,
    type ValueQuestion,
} from "@sous-io/plugin-api";
import type { InputStream, OutputStream } from "./io.js";

/**
 * The CLI's prompter. It asks on standard error and reads standard input, and only when it may
 * (L4): otherwise every question fails with a `NonInteractiveError` naming the flag that answers it.
 */
export class TerminalPrompter implements Prompter {
    constructor(
        private readonly input: InputStream,
        private readonly output: OutputStream,
        readonly interactive: boolean,
    ) {}

    async askValue(question: ValueQuestion): Promise<string> {
        this.refuseUnlessInteractive(question);

        for (;;) {
            const suffix = question.default !== undefined ? ` (${question.default})` : "";
            const answer = (await this.ask(`${question.message}${suffix} `)).trim() || question.default || "";
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
            const answer = (await this.ask(`Pick a number${fallback}: `)).trim();
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
            const answer = (await this.ask(`${question.message} ${hint} `)).trim().toLowerCase();

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
            throw new NonInteractiveError(question.message, question.answeredBy);
        }
    }

    private async ask(prompt: string): Promise<string> {
        const readline = createInterface({ input: this.input, output: this.output as NodeJS.WritableStream, terminal: false });

        try {
            return await readline.question(prompt);
        } finally {
            readline.close();
        }
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
    const ci = env.CI !== undefined && env.CI !== "" && env.CI !== "0" && env.CI.toLowerCase() !== "false";

    return Boolean(io.stdin.isTTY && io.stdout.isTTY) && !ci && globals["non-interactive"] !== true;
}
