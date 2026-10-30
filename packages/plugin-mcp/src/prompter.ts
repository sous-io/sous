import {
    CancelledError,
    type ChoiceQuestion,
    type ConfirmQuestion,
    NonInteractiveError,
    type Prompter,
    type QuestionBase,
    type ValueQuestion,
} from "@sous-io/plugin-api";
import type { ElicitRequestFormParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js";

/** What {@link ElicitationPrompter} asks through. */
export interface ElicitationPrompterOptions {
    /** Whether the client declared the elicitation capability. */
    readonly canElicit: boolean;
    /** Sends one `elicitation/create` request, tied to the tool call. */
    elicit(params: ElicitRequestFormParams): Promise<ElicitResult>;
    /** How many times a value that fails `validate` is asked again. Default 3. */
    readonly retries?: number;
}

/** The one field every form sous sends holds its answer in. */
const FIELD = "answer";

/**
 * A chain's questions as MCP elicitation, so `sous vars ask` works the
 * same in a terminal and in an agent session. When the client cannot elicit, every question fails
 * with a `NonInteractiveError` naming the tool argument that answers it. A declined or
 * cancelled form cancels the chain.
 *
 * ```ts
 * const prompter = new ElicitationPrompter({
 *     canElicit: Boolean(server.getClientCapabilities()?.elicitation),
 *     elicit: (params) => server.elicitInput(params, { relatedRequestId: extra.requestId }),
 * });
 * ```
 */
export class ElicitationPrompter implements Prompter {
    readonly interactive: boolean;

    constructor(private readonly options: ElicitationPrompterOptions) {
        this.interactive = options.canElicit;
    }

    async askValue(question: ValueQuestion): Promise<string> {
        let message = question.message;
        const tries = 1 + (this.options.retries ?? 3);

        for (let attempt = 1; attempt <= tries; attempt++) {
            const answer = String(
                await this.ask(question, message, {
                    type: "string",
                    title: question.message,
                    ...(question.default === undefined ? {} : { default: question.default }),
                }),
            );
            const problem = question.validate?.(answer);

            if (problem === undefined) {
                return answer;
            }

            message = `${question.message}\n\n${problem}`;
        }

        throw new CancelledError(question.message, `the answer was not accepted after ${tries} tries`);
    }

    async askChoice<T>(question: ChoiceQuestion<T>): Promise<T> {
        const options = question.choices.map((choice, index) => ({
            const: String(index),
            title: choice.description ? `${choice.label}: ${choice.description}` : choice.label,
        }));
        const answer = await this.ask(question, question.message, {
            type: "string",
            title: question.message,
            oneOf: options,
            ...(question.defaultIndex === undefined ? {} : { default: String(question.defaultIndex) }),
        });
        const picked = question.choices[Number(answer)];

        if (!picked) {
            throw new CancelledError(question.message, `the answer "${String(answer)}" is not one of the options`);
        }

        return picked.value;
    }

    async confirm(question: ConfirmQuestion): Promise<boolean> {
        const answer = await this.ask(question, question.message, {
            type: "boolean",
            title: question.message,
            ...(question.default === undefined ? {} : { default: question.default }),
        });

        return answer === true || answer === "true";
    }

    private async ask(
        question: QuestionBase,
        message: string,
        field: ElicitRequestFormParams["requestedSchema"]["properties"][string],
    ): Promise<unknown> {
        if (!this.interactive) {
            throw new NonInteractiveError(question.message, argumentFor(question.answeredBy));
        }

        const result = await this.options.elicit({
            mode: "form",
            message,
            requestedSchema: { type: "object", properties: { [FIELD]: field }, required: [FIELD] },
        });

        if (result.action !== "accept" || result.content?.[FIELD] === undefined) {
            const how = { accept: "answered with nothing", decline: "declined", cancel: "cancelled" }[result.action];

            throw new CancelledError(question.message, `the question was ${how} in the MCP client`);
        }

        return result.content[FIELD];
    }
}

/**
 * The tool argument that answers a question, from the CLI flag it names: `--yes` → `the "yes"
 * argument`, `--harness <id>` → `the "harness" argument`, `--dry-run` → `the "dryRun" argument`.
 */
export function argumentFor(answeredBy: string | undefined): string | undefined {
    if (answeredBy === undefined) {
        return undefined;
    }

    const word = answeredBy.trim().split(/\s+/)[0]!.replace(/^-+/, "").replace(/^<(.*)>$/, "$1");
    const name = word.replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());

    return name === "" ? answeredBy : `the "${name}" argument`;
}
