/**
 * A chain's output and questions, sent to the browser that submitted it: the web front end's
 * reporter and prompter (S1, Front Ends rule 2).
 */
import {
    BaseReporter,
    errorChain,
    LogLevel,
    messageText,
    NonInteractiveError,
    Payload,
    type ChoiceQuestion,
    type ConfirmQuestion,
    type Prompter,
    type ReportDetails,
    ReportEntryStyle,
    type ReportMessage as SousReportMessage,
    type ValueQuestion,
} from "@sous-io/plugin-api";
import type { AskMessage, Question, ReportMessage, ServerMessage } from "./protocol.js";

type Send = (message: ServerMessage) => void;

/**
 * Sends every message of one run as a `report`, with the same fields the MCP server sends: the
 * text, the style, and the details and payload fields as data. The result is not sent this way:
 * the run's `result` carries it.
 */
export class SocketReporter extends BaseReporter {
    constructor(
        private readonly id: number,
        private readonly send: Send,
    ) {
        super(LogLevel.Info);
    }

    protected write(level: LogLevel, message: SousReportMessage, details: ReportDetails | undefined, style: ReportEntryStyle): void {
        if (style === ReportEntryStyle.Banner || style === ReportEntryStyle.Result) {
            return;
        }

        const report: ReportMessage = { type: "report", id: this.id, level, message: messageText(message), style };
        const data = dataFor(message, details);

        if (data) {
            report.data = data;
        }

        this.send(report);
    }
}

function dataFor(message: SousReportMessage, details: ReportDetails | undefined): Record<string, unknown> | undefined {
    if (message instanceof Error) {
        return { ...details, errors: errorChain(message).map((error) => ({ name: error.name, message: error.message })) };
    }

    if (Payload.is(message)) {
        return { ...details, ...(message.toPlain() as Record<string, unknown>) };
    }

    return details === undefined ? undefined : { ...(details as Record<string, unknown>) };
}

/** Asks the browser, and waits for its `answer`. A closed socket fails the question. */
export class SocketPrompter implements Prompter {
    readonly interactive = true;
    private nextAsk = 0;
    private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; question: string }>();

    constructor(
        private readonly id: number,
        private readonly send: Send,
    ) {}

    askValue(question: ValueQuestion): Promise<string> {
        const asked: Question = { kind: "value", message: question.message };

        if (question.default !== undefined) asked.default = question.default;
        if (question.secret) asked.secret = true;

        return this.ask(asked, question.message).then(async (value) => {
            const answer = String(value ?? "");
            const problem = question.validate?.(answer);

            // The browser checks nothing, so an answer that fails the check is asked again, saying why.
            return problem === undefined ? answer : this.askValue({ ...question, message: `${question.message} (${problem})` });
        });
    }

    askChoice<T>(question: ChoiceQuestion<T>): Promise<T> {
        const asked: Question = {
            kind: "choice",
            message: question.message,
            choices: question.choices.map((choice) => (choice.description === undefined ? { label: choice.label } : { label: choice.label, description: choice.description })),
        };

        if (question.defaultIndex !== undefined) asked.defaultIndex = question.defaultIndex;

        return this.ask(asked, question.message).then((index) => {
            const choice = question.choices[Number(index)];

            if (!choice) {
                throw new NonInteractiveError(question.message, question.answeredBy);
            }

            return choice.value;
        });
    }

    confirm(question: ConfirmQuestion): Promise<boolean> {
        const asked: Question = { kind: "confirm", message: question.message };

        if (question.default !== undefined) asked.default = question.default;

        return this.ask(asked, question.message).then((value) => value === true);
    }

    /** The browser's answer to one of this run's questions. */
    answer(ask: number, value: unknown, cancelled: boolean): void {
        const waiting = this.waiting.get(ask);

        if (!waiting) {
            return;
        }

        this.waiting.delete(ask);

        if (cancelled) {
            waiting.reject(new NonInteractiveError(waiting.question, undefined));
        } else {
            waiting.resolve(value);
        }
    }

    /** Fails every question still waiting: the run ended or the socket closed. */
    abandon(): void {
        for (const [ask, waiting] of this.waiting) {
            this.waiting.delete(ask);
            waiting.reject(new NonInteractiveError(waiting.question, undefined));
        }
    }

    private ask(question: Question, text: string): Promise<unknown> {
        const ask = ++this.nextAsk;
        const message: AskMessage = { type: "ask", id: this.id, ask, question };

        return new Promise((resolve, reject) => {
            this.waiting.set(ask, { resolve, reject, question: text });
            this.send(message);
        });
    }
}
