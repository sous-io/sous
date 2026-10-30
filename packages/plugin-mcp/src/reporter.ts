import { isLevelShown, type LogLevel, type ProgressEvent, type ReportDetails, type Reporter } from "@sous-io/plugin-api";
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
 * A chain's output as MCP log messages. The eight sous levels are the eight MCP
 * levels, so each message keeps its level. Progress goes out as progress notifications when the
 * client gave a progress token, and as `debug` messages otherwise.
 *
 * ```ts
 * const reporter = new McpReporter({ send: extra.sendNotification, threshold: () => "info" });
 * reporter.warning("Recipe X declares a variable no template reads.");
 * ```
 */
export class McpReporter implements Reporter {
    private progressCount = 0;

    constructor(private readonly options: McpReporterOptions) {}

    log(level: LogLevel, message: string, details?: ReportDetails): void {
        if (!isLevelShown(level, this.options.threshold())) {
            return;
        }

        this.send({
            method: "notifications/message",
            params: {
                level,
                logger: this.options.logger ?? "sous",
                data: details === undefined ? message : { message, ...details },
            },
        });
    }

    progress(event: ProgressEvent): void {
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

    note(message: string, details?: ReportDetails): void {
        this.log("notice", message, details);
    }

    warning(message: string, details?: ReportDetails): void {
        this.log("warning", message, details);
    }

    private send(notification: ServerNotification): void {
        // A client that went away cannot hear it; reporting never fails the chain.
        this.options.send(notification).catch(() => {});
    }
}
