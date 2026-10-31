/**
 * What an intent returns: `IntentOutputs`, one or more `IntentOutput`s in the order they are shown.
 * Each output carries a result as a payload type a reporter knows how to show (`VariableSet`,
 * `Table`, ...), and converts to plain values for machines (`--json`, MCP, a calling intent).
 *
 * A payload is also what a reporter is given to show a structure while an intent runs:
 * `reporter.variables(...)` reports a `VariableSet`.
 */

import type { ReportEntryStyle, TableColumn, TreeNode, VariableEntry } from "./report-styles.js";

/** Marks a payload, so a reporter recognizes one even from another copy of this package. */
const PAYLOAD = Symbol.for("sous.payload");

/** Marks an `IntentOutputs`, for the same reason. */
const OUTPUTS = Symbol.for("sous.intent-outputs");

/** A plain object: what `toPlain()` returns. */
export type PlainObject = Record<string, unknown>;

/**
 * A structure a reporter knows how to show. Each payload holds plain values only, and converts to
 * them: `toPlain()` gives a plain object, and each type adds its own conversion (`toObject()`,
 * `toRows()`, ...). `toText()` is the payload as plain text, for a reporter that draws nothing.
 */
export abstract class Payload {
    /** Which payload type this is, so a reporter can show it without `instanceof`. */
    abstract readonly kind: string;

    readonly [PAYLOAD] = true;

    /** The payload as a plain object. */
    abstract toPlain(): PlainObject;

    /** The payload as plain text, one line per entry. */
    abstract toText(): string;

    /** Whether a value is a payload, from any copy of plugin-api. */
    static is(value: unknown): value is Payload {
        return typeof value === "object" && value !== null && (value as { [PAYLOAD]?: unknown })[PAYLOAD] === true;
    }
}

/** A value as text: nothing for `undefined` and `null`, JSON for an object. */
function textOf(value: unknown): string {
    if (value === undefined || value === null) {
        return "";
    }

    if (typeof value !== "object") {
        return String(value);
    }

    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

/** Labels and values, read as one block: `Repository: /work/recipes`. */
export class VariableSet extends Payload {
    readonly kind = "variable-set";
    readonly entries: readonly VariableEntry[];
    readonly title: string | undefined;

    /** @param entries - The pairs, or a record read as label and value pairs in its key order. */
    constructor(entries: readonly VariableEntry[] | Readonly<Record<string, unknown>>, options: { title?: string } = {}) {
        super();
        this.entries = Array.isArray(entries) ? [...(entries as readonly VariableEntry[])] : Object.entries(entries).map(([label, value]) => ({ label, value }));
        this.title = options.title;
    }

    /** The pairs as one object: `{ Repository: "/work/recipes" }`. A label used twice keeps its last value. */
    toObject(): PlainObject {
        return Object.fromEntries(this.entries.filter((entry) => entry.label !== "").map((entry) => [entry.label, entry.value]));
    }

    toPlain(): PlainObject {
        return this.toObject();
    }

    toText(): string {
        const lines = this.entries.map((entry) => `${entry.label}: ${textOf(entry.value)}${entry.detail === undefined ? "" : ` (${entry.detail})`}`);

        return [...(this.title === undefined ? [] : [this.title]), ...lines].join("\n");
    }
}

/** Rows under columns. */
export class Table extends Payload {
    readonly kind = "table";
    readonly columns: readonly TableColumn[];
    readonly rows: readonly Readonly<Record<string, unknown>>[];
    readonly title: string | undefined;
    /** What to say instead of the table when there are no rows. */
    readonly empty: string | undefined;
    /** A note shown under a row, by the row's index; `undefined` for a row with none. */
    readonly rowNotes: readonly (string | undefined)[] | undefined;

    constructor(
        columns: readonly TableColumn[],
        rows: readonly Readonly<Record<string, unknown>>[],
        options: { title?: string; empty?: string; rowNotes?: readonly (string | undefined)[] } = {},
    ) {
        super();
        this.columns = columns;
        this.rows = rows;
        this.title = options.title;
        this.empty = options.empty;
        this.rowNotes = options.rowNotes;
    }

    /** The rows. */
    toRows(): Readonly<Record<string, unknown>>[] {
        return [...this.rows];
    }

    toPlain(): PlainObject {
        return { rows: this.toRows() };
    }

    toText(): string {
        if (this.rows.length === 0 && this.empty !== undefined) {
            return this.empty;
        }

        const lines = this.rows.map((row) => this.columns.map((column) => textOf(row[column.key])).join("  "));

        return [...(this.title === undefined ? [] : [this.title]), ...lines].join("\n");
    }
}

/** A list of items, with an optional title before it and an optional sentence after it. */
export class ItemList extends Payload {
    readonly kind = "item-list";
    readonly items: readonly string[];
    readonly title: string | undefined;
    readonly footer: string | undefined;

    constructor(items: readonly string[], options: { title?: string; footer?: string } = {}) {
        super();
        this.items = items;
        this.title = options.title;
        this.footer = options.footer;
    }

    /** The items. */
    toArray(): string[] {
        return [...this.items];
    }

    toPlain(): PlainObject {
        return { items: this.toArray() };
    }

    toText(): string {
        return [...(this.title === undefined ? [] : [this.title]), ...this.items.map((item) => `- ${item}`), ...(this.footer === undefined ? [] : [this.footer])].join("\n");
    }
}

/** Items nested under other items. */
export class Tree extends Payload {
    readonly kind = "tree";
    readonly nodes: readonly TreeNode[];
    readonly title: string | undefined;

    constructor(nodes: readonly TreeNode[], options: { title?: string } = {}) {
        super();
        this.nodes = nodes;
        this.title = options.title;
    }

    toPlain(): PlainObject {
        return { nodes: this.nodes };
    }

    toText(): string {
        const lines = (nodes: readonly TreeNode[], depth: number): string[] =>
            nodes.flatMap((node) => [`${"  ".repeat(depth)}${node.label}${node.detail === undefined ? "" : ` (${node.detail})`}`, ...lines(node.children ?? [], depth + 1)]);

        return [...(this.title === undefined ? [] : [this.title]), ...lines(this.nodes, 0)].join("\n");
    }
}

/**
 * Text. A paragraph a reporter may wrap, or, with `verbatim`, text shown exactly as given (a value
 * a script reads, `--help`).
 */
export class TextBlock extends Payload {
    readonly kind = "text-block";
    readonly text: string;
    readonly verbatim: boolean;

    constructor(text: string, options: { verbatim?: boolean } = {}) {
        super();
        this.text = text;
        this.verbatim = options.verbatim === true;
    }

    override toString(): string {
        return this.text;
    }

    toPlain(): PlainObject {
        return { text: this.text };
    }

    toText(): string {
        return this.text;
    }
}

/** A structured value shown as data (a config as JSON). */
export class DataValue extends Payload {
    readonly kind = "data-value";
    readonly value: unknown;

    constructor(value: unknown) {
        super();
        this.value = value;
    }

    /** The value itself. */
    toValue(): unknown {
        return this.value;
    }

    /** The value when it is a plain object, else `{ value }`. */
    toPlain(): PlainObject {
        return typeof this.value === "object" && this.value !== null && !Array.isArray(this.value) ? (this.value as PlainObject) : { value: this.value };
    }

    toText(): string {
        try {
            return JSON.stringify(this.value, null, 2) ?? String(this.value);
        } catch {
            return String(this.value);
        }
    }
}

/** What one {@link IntentOutput} holds. */
export interface IntentOutputInit<T extends object = object> {
    /** A title above it, for people. */
    readonly title?: string;
    /** One or two sentences saying what it is or what happened, for people. */
    readonly summary?: string;
    /** The result, as a payload a reporter knows how to show. */
    readonly result?: Payload;
    /** What machines get (`--json`, MCP, a calling intent). Default: `result.toPlain()`. */
    readonly data?: T;
    /** A hint for the reporter about what this output is (`ReportEntryStyle.CommandVariables`, ...). */
    readonly style?: ReportEntryStyle;
}

/** One part of what an intent returns. */
export class IntentOutput<T extends object = object> {
    readonly title: string | undefined;
    readonly summary: string | undefined;
    readonly result: Payload | undefined;
    readonly data: T | undefined;
    readonly style: ReportEntryStyle | undefined;

    constructor(init: IntentOutputInit<T>) {
        this.title = init.title;
        this.summary = init.summary;
        this.result = init.result;
        this.data = init.data;
        this.style = init.style;
    }

    /** What machines get: `data`, else the result as a plain object, else `{}`. */
    toPlain(): T {
        return (this.data ?? this.result?.toPlain() ?? {}) as T;
    }

    /** The output as plain text: title, summary, then the result. */
    toText(): string {
        return [this.title, this.summary, this.result?.toText()].filter((part): part is string => part !== undefined && part !== "").join("\n");
    }
}

/**
 * What an intent returns: its outputs, in the order they are shown.
 *
 * ```ts
 * return new IntentOutputs(new IntentOutput({ summary: "Subscribed to acme/git.", result: new VariableSet({ Recipe: "acme/git" }) }));
 *
 * const prepared = (await ctx.run("build.prepare", {})).toPlain();   // the last output's plain object
 * ```
 */
export class IntentOutputs<T extends object = PlainObject> implements Iterable<IntentOutput> {
    readonly [OUTPUTS] = true;
    readonly #outputs: readonly IntentOutput[];
    /** The exit code the command ends with (a build with errors ends with 1). Default: none, so 0. */
    readonly exitCode: number | undefined;

    constructor(outputs: IntentOutput | readonly IntentOutput[] = [], options: { exitCode?: number } = {}) {
        this.#outputs = Array.isArray(outputs) ? [...(outputs as readonly IntentOutput[])] : [outputs as IntentOutput];
        this.exitCode = options.exitCode;
    }

    /** Outputs holding one plain value and nothing to show beyond it. */
    static of<T extends object>(data: T, init: Omit<IntentOutputInit<T>, "data"> = {}): IntentOutputs<T> {
        return new IntentOutputs<T>(new IntentOutput<T>({ ...init, data }));
    }

    /** Whether a value is an `IntentOutputs`, from any copy of plugin-api. */
    static is(value: unknown): value is IntentOutputs {
        return typeof value === "object" && value !== null && (value as { [OUTPUTS]?: unknown })[OUTPUTS] === true;
    }

    /** How many outputs there are. */
    get length(): number {
        return this.#outputs.length;
    }

    /** The outputs, in order. */
    toArray(): IntentOutput[] {
        return [...this.#outputs];
    }

    /** The first output, or `undefined`. */
    first(): IntentOutput | undefined {
        return this.#outputs[0];
    }

    /** The last output, or `undefined`. */
    last(): IntentOutput | undefined {
        return this.#outputs[this.#outputs.length - 1];
    }

    /** The last output's plain object (`{}` with none). Never an array. */
    toPlain(): T {
        return (this.last()?.toPlain() ?? {}) as T;
    }

    /** Every output as plain text, separated by a blank line. */
    toText(): string {
        return this.#outputs.map((output) => output.toText()).filter((text) => text !== "").join("\n\n");
    }

    /** New outputs with more appended, keeping the exit code (for a wrapper or an `after` listener). */
    with(...more: IntentOutput[]): IntentOutputs<T> {
        return new IntentOutputs<T>([...this.#outputs, ...more], this.exitCode === undefined ? {} : { exitCode: this.exitCode });
    }

    /**
     * The same outputs with `data` as what machines get: set on the last output, or as one output
     * holding only data when there is none. Use it when the last output shows something built from
     * a larger result.
     *
     * ```ts
     * return new IntentOutputs([commandVariables(ctx), table]).withData({ subscriptions });
     * ```
     */
    withData<D extends object>(data: D): IntentOutputs<D> {
        const outputs = [...this.#outputs];
        const last = outputs.pop();
        const replaced = last === undefined
            ? new IntentOutput<D>({ data })
            : new IntentOutput<D>({ ...(last.title === undefined ? {} : { title: last.title }), ...(last.summary === undefined ? {} : { summary: last.summary }), ...(last.result === undefined ? {} : { result: last.result }), ...(last.style === undefined ? {} : { style: last.style }), data });

        return new IntentOutputs<D>([...outputs, replaced], this.exitCode === undefined ? {} : { exitCode: this.exitCode });
    }

    /** The same outputs with another exit code. */
    withExitCode(exitCode: number): IntentOutputs<T> {
        return new IntentOutputs<T>([...this.#outputs], { exitCode });
    }

    [Symbol.iterator](): Iterator<IntentOutput> {
        return this.#outputs[Symbol.iterator]();
    }
}
