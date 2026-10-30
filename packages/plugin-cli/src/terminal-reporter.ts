import { BaseReporter, type LogLevel, type ProgressEvent, type ReportDetails } from "@sous-io/plugin-api";
import type { OutputStream } from "./io.js";
import { formatResolvedReference, isResolvedReference } from "./views/ref-report.js";
import { createStyle, type Style } from "./views/style.js";
import { terminalColumns } from "./views/text.js";

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
export class TerminalReporter extends BaseReporter {
    constructor(
        private readonly stream: OutputStream & { readonly columns?: number },
        threshold: LogLevel = "info",
        private readonly style: Style = createStyle(false),
    ) {
        super(threshold);
    }

    protected write(level: LogLevel, message: string, details?: ReportDetails): void {
        // A resolved reference (plugin-refs) is shown with its facts, as before the refactor.
        if (level === "notice" && isResolvedReference(details)) {
            const columns = this.stream.isTTY ? terminalColumns(this.stream) : terminalColumns(undefined);

            this.stream.write(`${formatResolvedReference(details, message, this.style, columns).join("\n")}\n`);

            return;
        }

        this.stream.write(`${PREFIX[level]}${message}\n`);
    }

    override progress(event: ProgressEvent): void {
        if (!this.shows("info")) {
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
}
