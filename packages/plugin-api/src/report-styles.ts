/**
 * The kinds of entry a reporter shows, and the facts each one carries in `details`. A style says what
 * an entry IS, never how it looks: each front end's reporter decides that. A new style is added here
 * when an output needs one, together with its convenience method in `BaseReporter` (reporter.ts),
 * which is the only way callers produce it.
 *
 * Every styled message also carries a plain-text `message`, so a reporter that ignores styles (a
 * log file, a test buffer) still has something readable.
 */

/** What kind of entry a reported message is. */
export const ReportEntryStyle = {
    /** A paragraph of text, which a front end may wrap. `details` is optional data. */
    Plain: "plain",
    /** Text shown exactly as given: no wrapping, no color (a value printed for a script to read). No details. */
    Text: "text",
    /** An explanation that is neither a warning nor an error. No details. */
    Note: "note",
    /** The start of an operation, such as "Building the project". {@link OperationStartDetails}. */
    OperationStart: "operation-start",
    /** A step inside the current operation, such as one target being compiled. {@link StepStartDetails}. */
    StepStart: "step-start",
    /** One line of detail inside the current operation or step. No details. */
    Detail: "detail",
    /** One action done (or to be done) to one target, such as a file written. {@link OperationDetails}. */
    Operation: "operation",
    /** How an operation ended, such as "Done." {@link OperationEndDetails}. */
    OperationEnd: "operation-end",
    /** One label and its value. {@link VariableDetails}. */
    Variable: "variable",
    /** Labels and values, read as one block, under an optional title. {@link VariableListDetails}. */
    VariableList: "variable-list",
    /** The facts a command runs with: the project, its config, ... {@link CommandVariablesDetails}. */
    CommandVariables: "command-variables",
    /** A list of items, with an optional title and closing sentence. {@link ListDetails}. */
    List: "list",
    /** A table of rows. {@link TableDetails}. */
    Table: "table",
    /** How many things were found. {@link CountDetails}. */
    Count: "count",
    /** Says that a run is a dry run, or what a dry run left undone. No details. */
    DryRun: "dry-run",
    /** Something wrong, with its cause and what to do about it. {@link ProblemDetails}. */
    Problem: "problem",
    /** What a name on the command line resolved to, and why. {@link ResolvedReferenceFacts}. */
    ResolvedReference: "resolved-reference",
    /** The question about to be asked, and where its answer goes. {@link QuestionDetails}. */
    Question: "question",
    /** A command sous runs (or would run). {@link CommandDetails}. */
    Command: "command",
    /** Progress through a longer step. {@link ProgressEvent}. */
    Progress: "progress",
    /** A structured value, such as a command's result as data. {@link DataDetails}. */
    Data: "data",
    /** The sous banner. No details. */
    Banner: "banner",
} as const;

/** One of the {@link ReportEntryStyle} values. */
export type ReportEntryStyle = (typeof ReportEntryStyle)[keyof typeof ReportEntryStyle];

/** {@link ReportEntryStyle.OperationStart}. */
export interface OperationStartDetails {
    /** What the operation does, in a few words: `Building the project`. */
    readonly name: string;
}

/** {@link ReportEntryStyle.StepStart}. */
export interface StepStartDetails {
    /** What the step does or works on: `CLAUDE.md`. */
    readonly name: string;
}

/**
 * What was done to a target. The `would-` actions are a dry run's: what a real run would do.
 *
 * - `written`: created or changed.
 * - `unchanged`: already as it should be; nothing written.
 * - `skipped`: left alone on purpose (the note says why).
 * - `failed`: not done because of an error.
 * - `removed`: deleted, such as an output no target produces any more.
 */
export type OperationAction = "written" | "would-write" | "unchanged" | "skipped" | "failed" | "removed" | "would-remove";

/** {@link ReportEntryStyle.Operation}. */
export interface OperationDetails {
    readonly action: OperationAction;
    /** What the action was done to: usually an absolute file path. */
    readonly target: string;
    /** Why, or anything else worth knowing, in a few words: `left out by the transform "strip"`. */
    readonly note?: string;
    /** For a written file: roughly how many tokens it holds. */
    readonly tokens?: number;
}

/** {@link ReportEntryStyle.OperationEnd}. */
export interface OperationEndDetails {
    /** Whether the operation succeeded. */
    readonly ok: boolean;
}

/** One label and its value. */
export interface VariableEntry {
    /** The name on the left. An empty label continues the entry above. */
    readonly label: string;
    /** The value. */
    readonly value: unknown;
    /** A secondary fact (where it came from), shown less prominently after the value. */
    readonly detail?: string;
}

/** {@link ReportEntryStyle.Variable}. */
export type VariableDetails = VariableEntry;

/** {@link ReportEntryStyle.VariableList}. */
export interface VariableListDetails {
    /** A title above the block. */
    readonly title?: string;
    readonly entries: readonly VariableEntry[];
}

/** {@link ReportEntryStyle.CommandVariables}. */
export interface CommandVariablesDetails {
    readonly entries: readonly VariableEntry[];
}

/** {@link ReportEntryStyle.List}. */
export interface ListDetails {
    /** The sentence or title introducing the list. */
    readonly title?: string;
    readonly items: readonly string[];
    /** A sentence after the list, such as what to do about it. */
    readonly footer?: string;
}

/** What a column holds, which decides how it aligns and where it is cut. */
export type ColumnKind = "text" | "path" | "url" | "number";

/** What a column does with a cell too long for it. */
export type ColumnOverflow = "wrap" | "truncate";

/** Which end of a cell is given up when it is cut. */
export type TruncateSide = "start" | "middle" | "end";

/** Where a cell sits inside its column. */
export type ColumnAlign = "left" | "right" | "center";

/** How willingly a column is hidden when there is no room for it. */
export type ColumnPriority = "low" | "medium" | "high";

/** One column of a table. Every field after `header` is a hint a front end may ignore. */
export interface TableColumn {
    /** The property each row is read from. */
    key: string;
    /** The heading shown above the column. */
    header: string;
    /** Whether a long cell wraps onto more lines or is cut. Defaults to wrapping. */
    overflow?: ColumnOverflow;
    /** Which end a cut takes from. Defaults by kind: the middle of a path or a URL, the end of anything else. */
    truncate?: TruncateSide;
    /** What the column holds. Defaults to plain text. */
    kind?: ColumnKind;
    /** Where a cell sits in the column. Defaults to the right for a number, the left for everything else. */
    align?: ColumnAlign;
    /** This column's share of any width left over once every column has its natural width. Defaults to none. */
    flex?: number;
    /** The narrowest this column is ever squeezed to. Defaults to the width of its heading. */
    minWidth?: number;
    /** How willingly the column is hidden. A high column is never hidden; a low one goes first. Defaults to high. */
    priority?: ColumnPriority;
}

/** {@link ReportEntryStyle.Table}. */
export interface TableDetails {
    /** A title above the table. */
    readonly title?: string;
    readonly columns: readonly TableColumn[];
    readonly rows: readonly Readonly<Record<string, unknown>>[];
    /** What to say instead of the table when there are no rows: `No repositories are added.` */
    readonly empty?: string;
}

/** {@link ReportEntryStyle.Count}. */
export interface CountDetails {
    readonly count: number;
    /** What was counted, already in the right number: `recipes`. */
    readonly entity: string;
    /** The verb before the count. Default `Found`; an empty string for none. */
    readonly verb?: string;
}

/** {@link ReportEntryStyle.Problem}. */
export interface ProblemDetails {
    /** What went wrong, in one sentence. */
    readonly summary: string;
    /** Why: the underlying error or the facts behind it. */
    readonly cause?: string;
    /** What to do about it. */
    readonly hint?: string;
    /** What it is about, such as a file or a recipe. */
    readonly subject?: string;
    /** For a problem in a file: the line. */
    readonly line?: number;
}

/** {@link ReportEntryStyle.ResolvedReference}: what a reference resolved to. */
export interface ResolvedReferenceFacts {
    /** What was typed. */
    readonly search: string;
    /** What it resolved to, in full. */
    readonly resolvedTo: string;
    /** What kind of thing it is: `recipe`, `namespace`, ... */
    readonly kind: string;
    readonly variable?: string;
    readonly recipe?: string;
    readonly namespace?: string;
    readonly repository?: string;
    readonly location?: string;
    readonly description?: string;
    /** Why this candidate won, in one sentence. */
    readonly reason?: string;
}

/** {@link ReportEntryStyle.Question}. */
export interface QuestionDetails {
    /** Its place in the run: question `index` of `total`. */
    readonly index: number;
    readonly total: number;
    /** The variable's name. */
    readonly name: string;
    readonly description?: string;
    readonly example?: string;
    /** The recipe that asks it. */
    readonly recipe?: string;
    /** The file its answer goes into. */
    readonly storedIn?: string;
    /** The environment variable name its answer is stored as. */
    readonly storedAs?: string;
}

/** {@link ReportEntryStyle.Command}. */
export interface CommandDetails {
    readonly command: string;
    readonly args: readonly string[];
    /** The directory it runs in. */
    readonly cwd?: string;
    /** True when it would run, but a dry run does not run it. */
    readonly dryRun?: boolean;
}

/** {@link ReportEntryStyle.Progress}: progress through a longer step, such as downloading recipes. */
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

/** {@link ReportEntryStyle.Data}. */
export interface DataDetails {
    readonly value: unknown;
}
