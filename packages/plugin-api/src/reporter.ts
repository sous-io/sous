/**
 * Reporting: services and intents never print. They report through the `Reporter` the front
 * end handed over with the chain (`ctx.reporter`), and the front end decides how it looks.
 *
 * Every message goes through one method, `log(level, message, details?, style?)`. The level says how
 * important it is, `details` carries its facts, and the style says what kind of entry it is (an
 * operation, a labeled value, a table, ...). Each front end's reporter decides how each style looks:
 * the CLI draws it with colors and alignment, MCP sends `details` as data. On top of `log` sit one
 * method per level (`info`, `warn`, ...) and one or more methods per style (`operationStart`, ...),
 * all defined once, in {@link BaseReporter}.
 */

import {
    type CommandDetails,
    type CommandVariablesDetails,
    type CountDetails,
    type DataDetails,
    type ListDetails,
    type OperationAction,
    type OperationDetails,
    type OperationEndDetails,
    type OperationStartDetails,
    type ProblemDetails,
    type ProgressEvent,
    type QuestionDetails,
    ReportEntryStyle,
    type ResolvedReferenceFacts,
    type StepStartDetails,
    type TableColumn,
    type TableDetails,
    type VariableDetails,
    type VariableEntry,
    type VariableListDetails,
} from "./report-styles.js";

export { ReportEntryStyle } from "./report-styles.js";
export type * from "./report-styles.js";

/** The eight syslog levels, by name. */
export const LogLevel = {
    Debug: "debug",
    Info: "info",
    Notice: "notice",
    Warning: "warning",
    Error: "error",
    Critical: "critical",
    Alert: "alert",
    Emergency: "emergency",
} as const;

/** One of the eight syslog levels. */
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

/** The eight syslog levels, from least to most severe. */
export const LOG_LEVELS: readonly LogLevel[] = [
    LogLevel.Debug,
    LogLevel.Info,
    LogLevel.Notice,
    LogLevel.Warning,
    LogLevel.Error,
    LogLevel.Critical,
    LogLevel.Alert,
    LogLevel.Emergency,
];

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

/**
 * The facts a message carries, which a front end may show or keep (MCP sends them as data). For a
 * styled message, its style's details type (`OperationDetails` for `ReportEntryStyle.Operation`, ...).
 */
export type ReportDetails = object;

/**
 * The shared part of every reporter, and the ONE place every reporting method is defined.
 * `Reporter`, the type plugins see, is derived from this class's public members, and the
 * {@link Reporting} mixin copies its convenience methods onto other classes, so a method added here
 * reaches every reporter and every class that mixes it in.
 *
 * A subclass writes a message that passes the threshold (`write`); everything else is shared.
 *
 * ```ts
 * class LinesReporter extends BaseReporter {
 *     readonly lines: string[] = [];
 *
 *     protected write(level: LogLevel, message: string): void {
 *         this.lines.push(`${level}: ${message}`);
 *     }
 * }
 *
 * const reporter = new LinesReporter(LogLevel.Warning);
 * reporter.notice("Skipped.");   // below the threshold: dropped
 * reporter.warn("Stale.");       // lines: ["warning: Stale."]
 * ```
 */
export abstract class BaseReporter {
    /**
     * @param thresholdSource - The least severe level shown (default `debug`, everything). A function
     *   is read on every message, for a threshold that changes while the reporter is in use.
     */
    constructor(private readonly thresholdSource: LogLevel | (() => LogLevel) = LogLevel.Debug) {}

    /** The least severe level shown now. */
    protected threshold(): LogLevel {
        return typeof this.thresholdSource === "function" ? this.thresholdSource() : this.thresholdSource;
    }

    /** Whether a message at `level` passes the threshold now. */
    protected shows(level: LogLevel): boolean {
        return isLevelShown(level, this.threshold());
    }

    /** Writes one message that passed the threshold, in the way this reporter shows `style`. */
    protected abstract write(level: LogLevel, message: string, details: ReportDetails | undefined, style: ReportEntryStyle): void;

    /**
     * Reports one message. Every other reporting method ends here.
     *
     * @param style - What kind of entry it is (default `ReportEntryStyle.Plain`, a paragraph).
     */
    log(level: LogLevel, message: string, details?: ReportDetails, style: ReportEntryStyle = ReportEntryStyle.Plain): void {
        if (this.shows(level)) {
            this.write(level, message, details, style);
        }
    }

    // -----------------------------------------------------------------------------------------
    // One method per level

    /** Reports a message for whoever is debugging sous. */
    debug(message: string, details?: ReportDetails, style?: ReportEntryStyle): void {
        this.log(LogLevel.Debug, message, details, style);
    }

    /** Reports an ordinary message. */
    info(message: string, details?: ReportDetails, style?: ReportEntryStyle): void {
        this.log(LogLevel.Info, message, details, style);
    }

    /** Reports a normal but significant event. */
    notice(message: string, details?: ReportDetails, style?: ReportEntryStyle): void {
        this.log(LogLevel.Notice, message, details, style);
    }

    /** Reports something that may need the user's attention. */
    warning(message: string, details?: ReportDetails, style?: ReportEntryStyle): void {
        this.log(LogLevel.Warning, message, details, style);
    }

    /** Shorthand for {@link warning}. */
    warn(message: string, details?: ReportDetails, style?: ReportEntryStyle): void {
        this.log(LogLevel.Warning, message, details, style);
    }

    /** Reports something that failed. */
    error(message: string, details?: ReportDetails, style?: ReportEntryStyle): void {
        this.log(LogLevel.Error, message, details, style);
    }

    /** Reports a failure that stops the run. */
    critical(message: string, details?: ReportDetails, style?: ReportEntryStyle): void {
        this.log(LogLevel.Critical, message, details, style);
    }

    /** Reports something that must be acted on at once. */
    alert(message: string, details?: ReportDetails, style?: ReportEntryStyle): void {
        this.log(LogLevel.Alert, message, details, style);
    }

    /** Reports that sous cannot work at all. */
    emergency(message: string, details?: ReportDetails, style?: ReportEntryStyle): void {
        this.log(LogLevel.Emergency, message, details, style);
    }

    /** Shorthand for {@link emergency}. */
    emerg(message: string, details?: ReportDetails, style?: ReportEntryStyle): void {
        this.log(LogLevel.Emergency, message, details, style);
    }

    // -----------------------------------------------------------------------------------------
    // One or more methods per style. Each forces its style, turns its parameters into a plain
    // `message` and typed `details`, and has a default level the last parameter overrides.

    /** Text shown exactly as given, such as a value a script reads: no wrapping, no color. */
    text(content: string, level: LogLevel = LogLevel.Info): void {
        this.log(level, content, undefined, ReportEntryStyle.Text);
    }

    /** An explanation that is neither a warning nor an error. */
    note(text: string, level: LogLevel = LogLevel.Notice): void {
        this.log(level, text, undefined, ReportEntryStyle.Note);
    }

    /** The start of an operation: `Building the project`. */
    operationStart(operationName: string, level: LogLevel = LogLevel.Notice): void {
        this.log(level, operationName, { name: operationName } satisfies OperationStartDetails, ReportEntryStyle.OperationStart);
    }

    /** A step inside the current operation: one target, one recipe, one check. */
    stepStart(stepName: string, level: LogLevel = LogLevel.Info): void {
        this.log(level, stepName, { name: stepName } satisfies StepStartDetails, ReportEntryStyle.StepStart);
    }

    /** One line of detail inside the current operation or step: `Read 12 recipes.` */
    detail(text: string, level: LogLevel = LogLevel.Info): void {
        this.log(level, text, undefined, ReportEntryStyle.Detail);
    }

    /**
     * One action done (or, in a dry run, to be done) to one target. The level defaults to `error`
     * for `failed` and `info` for everything else.
     *
     * ```ts
     * reporter.operation("written", "/work/app/CLAUDE.md", { tokens: 1840 });
     * reporter.operation("skipped", "/work/app/AGENTS.md", { note: 'left out by the transform "strip"' });
     * ```
     */
    operation(action: OperationAction, target: string, facts: Omit<OperationDetails, "action" | "target"> = {}, level?: LogLevel): void {
        const details: OperationDetails = { action, target, ...facts };
        const text = facts.note === undefined ? `${action}: ${target}` : `${action}: ${target} (${facts.note})`;

        this.log(level ?? (action === "failed" ? LogLevel.Error : LogLevel.Info), text, details, ReportEntryStyle.Operation);
    }

    /** How an operation ended: `Done.`, or `Done with 2 errors.` The level defaults to `info`, or `error` when it failed. */
    operationEnd(summary: string, ok = true, level?: LogLevel): void {
        this.log(level ?? (ok ? LogLevel.Info : LogLevel.Error), summary, { ok } satisfies OperationEndDetails, ReportEntryStyle.OperationEnd);
    }

    /** One label and its value: `Repository: /work/recipes`. */
    variable(label: string, value: unknown, detail?: string, level: LogLevel = LogLevel.Info): void {
        const details: VariableDetails = detail === undefined ? { label, value } : { label, value, detail };

        this.log(level, `${label}: ${plainValue(value)}`, details, ReportEntryStyle.Variable);
    }

    /**
     * Labels and values, read as one block (a terminal lines their colons up). A record is read as
     * label and value pairs, in its key order.
     */
    variables(entries: readonly VariableEntry[] | Readonly<Record<string, unknown>>, title?: string, level: LogLevel = LogLevel.Info): void {
        const list = toEntries(entries);
        const details: VariableListDetails = title === undefined ? { entries: list } : { title, entries: list };

        this.log(level, joinLines(title, list.map(entryText)), details, ReportEntryStyle.VariableList);
    }

    /** The facts a command runs with (its project, its config, what it reads), shown before its output. */
    commandVariables(entries: readonly VariableEntry[] | Readonly<Record<string, unknown>>, level: LogLevel = LogLevel.Info): void {
        const list = toEntries(entries);

        this.log(level, joinLines("Command Variables", list.map(entryText)), { entries: list } satisfies CommandVariablesDetails, ReportEntryStyle.CommandVariables);
    }

    /** A list of items, with an optional title before it and an optional sentence after it. */
    list(items: readonly string[], options: { title?: string; footer?: string } = {}, level: LogLevel = LogLevel.Info): void {
        const details: ListDetails = { ...options, items };

        this.log(level, joinLines(options.title, items.map((item) => `- ${item}`), options.footer), details, ReportEntryStyle.List);
    }

    /** A table of rows. With no rows, a front end shows `options.empty` when it is given. */
    table(columns: readonly TableColumn[], rows: readonly Readonly<Record<string, unknown>>[], options: { title?: string; empty?: string } = {}, level: LogLevel = LogLevel.Info): void {
        const details: TableDetails = { ...options, columns, rows };
        const text = rows.length === 0 && options.empty !== undefined
            ? options.empty
            : joinLines(options.title, rows.map((row) => columns.map((column) => plainValue(row[column.key])).join("  ")));

        this.log(level, text, details, ReportEntryStyle.Table);
    }

    /** How many things were found: `Found 5 recipes`. `entity` is already in the right number. */
    count(count: number, entity: string, verb = "Found", level: LogLevel = LogLevel.Info): void {
        this.log(level, `${verb === "" ? "" : `${verb} `}${count} ${entity}`, { count, entity, verb } satisfies CountDetails, ReportEntryStyle.Count);
    }

    /** Says that a run is a dry run, or what a dry run left undone: `Nothing was written.` */
    dryRun(text: string, level: LogLevel = LogLevel.Notice): void {
        this.log(level, text, undefined, ReportEntryStyle.DryRun);
    }

    /**
     * Something wrong, with its cause and what to do about it. A one-sentence warning with nothing
     * more to say is `warn(text)` instead.
     *
     * ```ts
     * reporter.problem("The compilation transform \"strip\" is not registered.", { subject: "CLAUDE.md", hint: "Install the plugin that adds it." });
     * ```
     */
    problem(summary: string, facts: Omit<ProblemDetails, "summary"> = {}, level: LogLevel = LogLevel.Warning): void {
        const details: ProblemDetails = { summary, ...facts };

        this.log(level, joinLines(summary, [facts.cause, facts.hint].filter((part): part is string => part !== undefined)), details, ReportEntryStyle.Problem);
    }

    /** What a name on the command line resolved to, and why (`reason`, one sentence). */
    resolvedReference(reason: string, facts: ResolvedReferenceFacts, level: LogLevel = LogLevel.Notice): void {
        this.log(level, reason, { ...facts, reason }, ReportEntryStyle.ResolvedReference);
    }

    /** The question about to be asked, and where its answer goes. */
    question(facts: QuestionDetails, level: LogLevel = LogLevel.Notice): void {
        this.log(level, `Question ${facts.index} of ${facts.total}: ${facts.name}`, { ...facts }, ReportEntryStyle.Question);
    }

    /** A command sous runs, or (with `dryRun`) would run. */
    command(command: string, args: readonly string[], facts: Omit<CommandDetails, "command" | "args"> = {}, level: LogLevel = LogLevel.Notice): void {
        const line = [command, ...args].join(" ");
        const text = `${facts.dryRun ? "Would run" : "Running"}: ${line}${facts.cwd === undefined ? "" : ` (in ${facts.cwd})`}`;

        this.log(level, text, { command, args, ...facts } satisfies CommandDetails, ReportEntryStyle.Command);
    }

    /**
     * Progress through a longer step. A terminal draws one bar and redraws it in place; the event
     * with `finished: true` ends it.
     */
    progress(event: ProgressEvent, level: LogLevel = LogLevel.Info): void {
        this.log(level, event.label, { ...event }, ReportEntryStyle.Progress);
    }

    /** A structured value, such as a command's result as data. */
    data(value: unknown, level: LogLevel = LogLevel.Info): void {
        this.log(level, safeJson(value), { value } satisfies DataDetails, ReportEntryStyle.Data);
    }

    /** The sous banner. */
    banner(level: LogLevel = LogLevel.Info): void {
        this.log(level, "sous", undefined, ReportEntryStyle.Banner);
    }
}

/** A value as plain text: nothing for `undefined` and `null`, JSON for an object. */
function plainValue(value: unknown): string {
    if (value === undefined || value === null) {
        return "";
    }

    return typeof value === "object" ? safeJson(value) : String(value);
}

/** JSON text, or `String(value)` when it cannot be serialized (a cycle, a BigInt). */
function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
        return String(value);
    }
}

/** Label and value pairs from an array of entries or a record. */
function toEntries(entries: readonly VariableEntry[] | Readonly<Record<string, unknown>>): readonly VariableEntry[] {
    return Array.isArray(entries) ? (entries as readonly VariableEntry[]) : Object.entries(entries).map(([label, value]) => ({ label, value }));
}

/** One entry as `Label: value (detail)`. */
function entryText(entry: VariableEntry): string {
    return `${entry.label}: ${plainValue(entry.value)}${entry.detail === undefined ? "" : ` (${entry.detail})`}`;
}

/** The lines that are given, one per line; an array's lines are indented two spaces under a title. */
function joinLines(first: string | undefined, rest: readonly string[], last?: string): string {
    const body = first === undefined ? rest : rest.map((line) => `  ${line}`);

    return [first, ...body, last].filter((line): line is string => line !== undefined).join("\n");
}

/**
 * Where a chain's output goes: every public method of {@link BaseReporter}. Each front end supplies
 * its own (the CLI writes to the terminal, MCP sends log notifications) by extending `BaseReporter`.
 */
export type Reporter = { [K in keyof BaseReporter]: BaseReporter[K] };

/** The reporting methods {@link Reporting} copies onto a class: every one except `log`. */
export type ReportingMethods = Omit<Reporter, "log">;

/** The members of `BaseReporter.prototype` that {@link Reporting} does not copy. */
const NOT_ALIASED: readonly string[] = ["constructor", "log", "write", "threshold", "shows"];

/** A class, abstract or not. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AbstractConstructor<T = object> = abstract new (...args: any[]) => T;

/**
 * Gives a class every reporting method of {@link BaseReporter} (`info`, `warn`, `operationStart`,
 * ...) as a shorthand for the same method on its `reporter`, which the class provides. The methods
 * are copied from `BaseReporter.prototype` when the mixin is applied, so nothing lists them twice.
 * They are public, since a type can only make a member protected inside a class body.
 *
 * ```ts
 * class Compiler extends Reporting(Object) {
 *     constructor(private readonly deps: { reporter: Reporter }) {
 *         super();
 *     }
 *
 *     protected get reporter(): Reporter {
 *         return this.deps.reporter;
 *     }
 *
 *     run(): void {
 *         this.info("Compiling");   // this.deps.reporter.info("Compiling")
 *     }
 * }
 * ```
 */
export function Reporting<TBase extends AbstractConstructor>(Base: TBase) {
    abstract class WithReporting extends Base {
        /** Where the reporting methods send their messages. */
        protected abstract get reporter(): Reporter;
    }

    for (const name of Object.getOwnPropertyNames(BaseReporter.prototype)) {
        if (NOT_ALIASED.includes(name)) {
            continue;
        }

        Object.defineProperty(WithReporting.prototype, name, {
            configurable: true,
            writable: true,
            value(this: { reporter: Reporter }, ...args: unknown[]): unknown {
                return (this.reporter as unknown as Record<string, (...rest: unknown[]) => unknown>)[name]!(...args);
            },
        });
    }

    return WithReporting as typeof WithReporting & AbstractConstructor<ReportingMethods>;
}

/** One message a {@link BufferedReporter} kept. */
export interface ReportedMessage {
    level: LogLevel;
    message: string;
    details?: ReportDetails;
    style: ReportEntryStyle;
}

/**
 * Builds a reporter from a function that receives every message, whatever its level.
 *
 * ```ts
 * const reporter = createReporter((level, message) => lines.push(`${level}: ${message}`));
 * reporter.warn("Recipe X declares a variable no template reads.");
 * ```
 */
export function createReporter(
    log: (level: LogLevel, message: string, details: ReportDetails | undefined, style: ReportEntryStyle) => void,
): Reporter {
    return new (class FunctionReporter extends BaseReporter {
        protected write(level: LogLevel, message: string, details: ReportDetails | undefined, style: ReportEntryStyle): void {
            log(level, message, details, style);
        }
    })();
}

/** A reporter that drops everything. */
export const nullReporter: Reporter = createReporter(() => {});

/**
 * A reporter that keeps every message, to hand on later ({@link flushTo}) or to read in tests.
 */
export class BufferedReporter extends BaseReporter {
    /** Every message, in order. */
    readonly messages: ReportedMessage[] = [];

    protected write(level: LogLevel, message: string, details: ReportDetails | undefined, style: ReportEntryStyle): void {
        this.messages.push(details === undefined ? { level, message, style } : { level, message, details, style });
    }

    /** The messages at a level. */
    at(level: LogLevel): string[] {
        return this.messages.filter((entry) => entry.level === level).map((entry) => entry.message);
    }

    /** The messages of a style. */
    styled(style: ReportEntryStyle): ReportedMessage[] {
        return this.messages.filter((entry) => entry.style === style);
    }

    /** Sends every kept message to another reporter, in order, and forgets them. */
    flushTo(reporter: Reporter): void {
        for (const entry of this.messages.splice(0)) {
            reporter.log(entry.level, entry.message, entry.details, entry.style);
        }
    }
}
