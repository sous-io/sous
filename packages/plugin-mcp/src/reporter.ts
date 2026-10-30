import { BaseReporter, type LogLevel, type ProgressEvent, type ReportDetails, ReportEntryStyle } from "@sous-io/plugin-api";
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
 * `message`, so a client that ignores styles still reads it. Progress goes out as progress
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

    protected write(level: LogLevel, message: string, details: ReportDetails | undefined, style: ReportEntryStyle): void {
        if (style === ReportEntryStyle.Banner) {
            return;
        }

        if (style === ReportEntryStyle.Progress) {
            this.sendProgress((details as ProgressEvent | undefined) ?? { label: message });

            return;
        }

        this.send({
            method: "notifications/message",
            params: {
                level,
                logger: this.options.logger ?? "sous",
                data: details === undefined && style === ReportEntryStyle.Plain ? message : { message, style, ...details },
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
