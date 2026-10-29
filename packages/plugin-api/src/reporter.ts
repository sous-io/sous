/**
 * Reporting (L3): services and intents never print. They report through the `Reporter` the front
 * end handed over with the chain (`ctx.reporter`), and the front end decides how it looks.
 */

/** The eight syslog levels, in full, from least to most severe (S1, "Log levels"). */
export const LOG_LEVELS = [
    "debug",
    "info",
    "notice",
    "warning",
    "error",
    "critical",
    "alert",
    "emergency",
] as const;

/** One of the eight syslog levels. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Whether a string names a log level. */
export function isLogLevel(value: unknown): value is LogLevel {
    return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Whether a message at `level` shows when the threshold is `threshold`.
 *
 * ```ts
 * isLevelShown("warning", "notice");   // true
 * isLevelShown("debug", "info");       // false
 * ```
 */
export function isLevelShown(level: LogLevel, threshold: LogLevel): boolean {
    return LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(threshold);
}

/** Progress through a longer step, such as downloading recipes. */
export interface ProgressEvent {
    /** What is in progress, in a few words: `Downloading recipes`. */
    label: string;
    /** How far along: items done so far. */
    done?: number;
    /** How far along: items in total, when known. */
    total?: number;
    /** The item being worked on now. */
    item?: string;
    /** True on the last event of this label. */
    finished?: boolean;
}

/** Extra facts a message may carry, which a front end may show or keep (MCP sends them as data). */
export type ReportDetails = Readonly<Record<string, unknown>>;

/**
 * Where a chain's output goes. Each front end supplies its own: the CLI writes to the terminal, MCP
 * sends log notifications, a web front end streams to the browser.
 */
export interface Reporter {
    /** Reports a message at a level. */
    log(level: LogLevel, message: string, details?: ReportDetails): void;
    /** Reports progress through a longer step. */
    progress(event: ProgressEvent): void;
    /** Shorthand for `log("notice", message)`. */
    note(message: string, details?: ReportDetails): void;
    /** Shorthand for `log("warning", message)`. */
    warning(message: string, details?: ReportDetails): void;
}

/** One message a {@link BufferedReporter} kept. */
export interface ReportedMessage {
    level: LogLevel;
    message: string;
    details?: ReportDetails;
}

/**
 * Builds a full `Reporter` from a `log` function (and, optionally, a `progress` one).
 *
 * ```ts
 * const reporter = createReporter((level, message) => lines.push(`${level}: ${message}`));
 * reporter.warning("Recipe X declares a variable no template reads.");
 * ```
 */
export function createReporter(
    log: (level: LogLevel, message: string, details?: ReportDetails) => void,
    progress: (event: ProgressEvent) => void = () => {},
): Reporter {
    return {
        log,
        progress,
        note: (message, details) => log("notice", message, details),
        warning: (message, details) => log("warning", message, details),
    };
}

/** A reporter that drops everything. */
export const nullReporter: Reporter = createReporter(() => {});

/**
 * A reporter that keeps every message, to hand on later ({@link flushTo}) or to read in tests.
 */
export class BufferedReporter implements Reporter {
    /** Every message, in order. */
    readonly messages: ReportedMessage[] = [];
    /** Every progress event, in order. */
    readonly progressEvents: ProgressEvent[] = [];

    log(level: LogLevel, message: string, details?: ReportDetails): void {
        this.messages.push(details === undefined ? { level, message } : { level, message, details });
    }

    progress(event: ProgressEvent): void {
        this.progressEvents.push(event);
    }

    note(message: string, details?: ReportDetails): void {
        this.log("notice", message, details);
    }

    warning(message: string, details?: ReportDetails): void {
        this.log("warning", message, details);
    }

    /** The messages at a level. */
    at(level: LogLevel): string[] {
        return this.messages.filter((entry) => entry.level === level).map((entry) => entry.message);
    }

    /** Sends every kept message and progress event to another reporter, and forgets them. */
    flushTo(reporter: Reporter): void {
        for (const entry of this.messages.splice(0)) {
            reporter.log(entry.level, entry.message, entry.details);
        }

        for (const event of this.progressEvents.splice(0)) {
            reporter.progress(event);
        }
    }
}
