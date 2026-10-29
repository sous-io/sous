import { isLevelShown, type LogLevel, type ProgressEvent, type ReportDetails, type Reporter } from "@sous-io/plugin-api";
import type { OutputStream } from "./io.js";

const PREFIX: Record<LogLevel, string> = {
    debug: "Debug: ",
    info: "",
    notice: "",
    warning: "Warning: ",
    error: "Error: ",
    critical: "Critical: ",
    alert: "Alert: ",
    emergency: "Emergency: ",
};

/**
 * The CLI's reporter: messages at or above the threshold go to standard error, each with a literal
 * prefix (`Warning: `, `Error: `) so they stay findable with color off and in logs.
 */
export class TerminalReporter implements Reporter {
    constructor(
        private readonly stream: OutputStream,
        private readonly threshold: LogLevel = "info",
    ) {}

    log(level: LogLevel, message: string, _details?: ReportDetails): void {
        if (isLevelShown(level, this.threshold)) {
            this.stream.write(`${PREFIX[level]}${message}\n`);
        }
    }

    progress(event: ProgressEvent): void {
        if (!isLevelShown("info", this.threshold)) {
            return;
        }

        const count = event.done !== undefined ? ` ${event.done}${event.total !== undefined ? `/${event.total}` : ""}` : "";
        const item = event.item ? ` ${event.item}` : "";
        const line = `${event.label}${count}${item}`;

        if (this.stream.isTTY) {
            this.stream.write(`\r\u001b[2K${line}${event.finished ? "\n" : ""}`);
        } else if (event.finished) {
            this.stream.write(`${line}\n`);
        }
    }

    note(message: string, details?: ReportDetails): void {
        this.log("notice", message, details);
    }

    warning(message: string, details?: ReportDetails): void {
        this.log("warning", message, details);
    }
}
