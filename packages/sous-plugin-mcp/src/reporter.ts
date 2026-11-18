import { BaseReporter, errorChain, type LogLevel, messageText, Payload, type ProgressEvent, type ReportDetails, ReportEntryStyle, type ReportMessage } from "@sous-io/plugin-api";
import type { ServerNotification } from "@modelcontextprotocol/sdk/types.js";

/** What {@link McpReporter} sends through: one client, in the context of one tool call. */
export interface McpReporterOptions {
    /** Sends a notification to the client, tied to the tool call when it can be. */
    send(notification: ServerNotification): Promise<void>;
    /** The level the client asked for (`logging/setLevel`), read on every message. */
    threshold(): LogLevel;
    /** The call's progress token, when the client asked for progress. */
    progressToken?: string | number;
    /** The logger name in log messages. Default `sous`. */
    logger?: string;
}

/**
 * A chain's output as MCP log messages. The eight sous levels are the eight MCP levels, so each
 * message keeps its level. A message with details or a style sends them as data next to the plain
 * `message`, so a client that ignores styles still reads it. An `Error` sends its cause chain as the
 * message text and as `errors` (`{ name, message }` per error, outermost first); a payload sends its
 * text as `message` and its `toPlain()` fields. A command's result (`ReportEntryStyle.Result`) is not
 * sent: the tool call returns it. Progress goes out as progress
 * notifications when the client gave a progress token, and as `debug` messages otherwise. The banner
 * is dropped.
 *
 * ```ts
 * const reporter = new McpReporter({ send: extra.sendNotification, threshold: () => "info" });
 * reporter.warning("Recipe X declares a variable no template reads.");
 * ```
 */
export class McpReporter extends BaseReporter {
    private progressCount = 0;

    constructor(private readonly options: McpReporterOptions) {
        super(options.threshold);
    }

    /**
     * A client that sent a progress token asked for progress, so it gets every event whatever its
     * log level; without a token, progress is a message like any other.
     */
    override progress(event: ProgressEvent, level?: LogLevel): void {
        if (this.options.progressToken !== undefined) {
            this.sendProgress(event);

            return;
        }

        super.progress(event, level);
    }

    protected write(level: LogLevel, message: ReportMessage, details: ReportDetails | undefined, style: ReportEntryStyle): void {
        if (style === ReportEntryStyle.Banner || style === ReportEntryStyle.Result) {
            return;
        }

        const text = messageText(message);

        if (style === ReportEntryStyle.Progress) {
            this.sendProgress((details as ProgressEvent | undefined) ?? { label: text });

            return;
        }

        this.send({
            method: "notifications/message",
            params: {
                level,
                logger: this.options.logger ?? "sous",
                data: dataFor(text, message, details, style),
            },
        });
    }

    private sendProgress(event: ProgressEvent): void {
        const text = event.item ? `${event.label}: ${event.item}` : event.label;

        if (this.options.progressToken === undefined) {
            this.log("debug", event.finished ? `${event.label}: done` : text);

            return;
        }

        // MCP wants progress to rise on every notification, so a count stands in when `done` is missing.
        this.progressCount = Math.max(this.progressCount + (event.done === undefined ? 1 : 0), event.done ?? 0);

        this.send({
            method: "notifications/progress",
            params: {
                progressToken: this.options.progressToken,
                progress: this.progressCount,
                ...(event.total === undefined ? {} : { total: event.total }),
                message: text,
            },
        });
    }

    private send(notification: ServerNotification): void {
        // A client that went away cannot hear it; reporting never fails the chain.
        this.options.send(notification).catch(() => {});
    }
}

/** What a log message carries: the text alone when nothing more is known, else the text, style and facts. */
function dataFor(text: string, message: ReportMessage, details: ReportDetails | undefined, style: ReportEntryStyle): string | Record<string, unknown> {
    if (message instanceof Error) {
        return { message: text, style, ...details, errors: errorChain(message).map((error) => ({ name: error.name, message: error.message })) };
    }

    if (Payload.is(message)) {
        return { message: text, style, ...details, ...message.toPlain() };
    }

    return details === undefined && style === ReportEntryStyle.Plain ? text : { message: text, style, ...details };
}
