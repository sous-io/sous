import { BaseReporter, type Environment, isLevelShown, LogLevel, type ProgressEvent, type ReportDetails, ReportEntryStyle } from "@sous-io/plugin-api";
import type { OutputStream } from "./io.js";
import { BLANK, Layout } from "./terminal/layout.js";
import { type Rendered, renderEntry, type RenderState } from "./terminal/render-entry.js";
import { colorEnabled, createStyle, type Style } from "./views/style.js";
import { displayWidth, terminalColumns } from "./views/text.js";

/** A stream the reporter writes to; a terminal also says how wide it is. */
export type ReporterStream = OutputStream & { readonly columns?: number };

/** What a {@link TerminalReporter} is built from. */
export interface TerminalReporterOptions {
    /** Where `debug`, `info` and `notice` go (and nothing else under `json`). */
    readonly stdout: ReporterStream;
    /** Where `warning` and above go, and everything when `json` is on. */
    readonly stderr: ReporterStream;
    /** The least severe level shown. Default `info`. */
    readonly threshold?: LogLevel;
    /** Whether output is colored. Default: decided for each stream by {@link colorEnabled}. */
    readonly color?: boolean;
    /** The environment `NO_COLOR`, `FORCE_COLOR` and `TERM` are read from. Default: none set. */
    readonly env?: Environment;
    /** The width output is laid out in. Default: a terminal's own width, else 100. */
    readonly columns?: number;
    /** Sends every message to standard error, so standard output holds only the result. */
    readonly json?: boolean;
}

/** One stream, with what is needed to lay out and space what is written to it. */
class Sink {
    readonly layout: Layout;
    /** How many blank lines end what was written so far. */
    blanks = 0;
    /** Whether anything was written yet. */
    wrote = false;
    /** How many blank lines the next entry should have above it. */
    pending = 0;

    constructor(
        readonly stream: ReporterStream,
        color: boolean,
        columns: number,
    ) {
        this.layout = new Layout(createStyle(color), columns, stream.isTTY === true);
    }
}

/** Clears the line the cursor is on. */
const CLEAR_LINE = "\r\u001b[2K";

/** How many cells the progress bar has. */
const BAR_CELLS = 20;

/** How many blank lines end a command's output. */
const FOOTER_BLANKS = 2;

/**
 * The CLI's reporter: it draws every {@link ReportEntryStyle} the way the CLI looks (colors, glyphs,
 * aligned blocks, wrapped paragraphs, tables), decides the blank lines between entries from the
 * sequence of styles, and sends each entry to a stream by its level.
 *
 * - `debug`, `info` and `notice` go to standard output; `warning` and above go to standard error.
 *   With `json`, everything goes to standard error.
 * - The banner, a question's header and a progress bar always go to standard error: they belong
 *   to a person at a terminal, and the prompts are written there.
 * - Color is decided for each stream, so a piped standard output stays plain while standard error is colored.
 * - Only one progress bar shows at a time; on a terminal it is redrawn in place and kept under any
 *   message printed while it shows. Elsewhere only its last event prints, as one line.
 *
 * Call {@link finish} when a command's output is done.
 *
 * ```ts
 * const reporter = new TerminalReporter({ stdout: process.stdout, stderr: process.stderr, env: process.env });
 *
 * reporter.operationStart("Building the project");
 * reporter.operation("written", "/work/app/CLAUDE.md", { tokens: 1840 });
 * reporter.finish();
 * ```
 */
export class TerminalReporter extends BaseReporter {
    private readonly out: Sink;
    private readonly err: Sink;
    private readonly state: RenderState = { step: false };
    private bar: { readonly sink: Sink; readonly text: string } | undefined;
    private footerSink: Sink | undefined;

    constructor(options: TerminalReporterOptions) {
        super(options.threshold ?? LogLevel.Info);

        const env = options.env ?? {};
        const sinkOf = (stream: ReporterStream) =>
            new Sink(stream, options.color ?? colorEnabled(stream, env), options.columns ?? (stream.isTTY === true ? terminalColumns(stream) : terminalColumns(undefined)));

        this.err = sinkOf(options.stderr);
        this.out = options.json === true ? this.err : sinkOf(options.stdout);
    }

    /** The colors of the stream a message at `level` goes to, for text that is built before it is reported. */
    styleFor(level: LogLevel): Style {
        return this.sinkFor(level, ReportEntryStyle.Plain).layout.style;
    }

    /** Ends a command's output: removes a progress bar that is still showing and writes the closing blank lines. */
    finish(): void {
        this.endBar();

        const sink = this.footerSink;

        this.footerSink = undefined;

        if (sink === undefined || !sink.wrote) {
            return;
        }

        this.emit(sink, { lines: Array.from({ length: Math.max(0, FOOTER_BLANKS - sink.blanks) }, () => BLANK) });
        sink.pending = 0;
    }

    protected write(level: LogLevel, message: string, details: ReportDetails | undefined, style: ReportEntryStyle): void {
        if (style === ReportEntryStyle.Progress) {
            this.drawProgress(details as ProgressEvent | undefined, message);

            return;
        }

        const sink = this.sinkFor(level, style);
        const rendered = renderEntry(sink.layout, this.state, level, message, details, style);

        if (rendered.lines.length > 0) {
            this.emit(sink, rendered);
        }

        if (rendered.footer === true) {
            this.footerSink = sink;
        }
    }

    /** The stream an entry goes to. */
    private sinkFor(level: LogLevel, style: ReportEntryStyle): Sink {
        if (style === ReportEntryStyle.Banner || style === ReportEntryStyle.Question || style === ReportEntryStyle.Progress) {
            return this.err;
        }

        return isLevelShown(level, LogLevel.Warning) ? this.err : this.out;
    }

    /** Writes an entry's lines, with the blank lines it needs above them, keeping a progress bar under them. */
    private emit(sink: Sink, rendered: Rendered): void {
        const gap = sink.wrote ? Math.max(rendered.gapBefore ?? 0, sink.pending) - sink.blanks : 0;
        const lines = [...Array.from({ length: Math.max(0, gap) }, () => BLANK), ...rendered.lines];
        let text = "";

        for (const line of lines) {
            text += `${line}\n`;
            sink.blanks = line.trim() === "" ? sink.blanks + 1 : 0;
        }

        if (this.bar !== undefined) {
            this.bar.sink.stream.write(CLEAR_LINE);
        }

        sink.stream.write(text);
        sink.wrote = true;
        sink.pending = rendered.gapAfter ?? 0;

        if (this.bar !== undefined) {
            this.bar.sink.stream.write(this.bar.text);
        }
    }

    /** Draws a progress event as the one bar on a terminal, or prints the last one as a line. */
    private drawProgress(event: ProgressEvent | undefined, message: string): void {
        const sink = this.err;
        const progress: ProgressEvent = event ?? { label: message };
        const layout = sink.layout;

        if (sink.stream.isTTY !== true) {
            if (progress.finished === true) {
                this.emit(sink, { lines: [finishedLine(layout, progress)] });
            }

            return;
        }

        if (progress.finished === true) {
            this.bar = undefined;
            sink.stream.write(CLEAR_LINE);
            this.emit(sink, { lines: [finishedLine(layout, progress)] });

            return;
        }

        this.bar = { sink, text: barText(layout, progress) };
        sink.stream.write(`${CLEAR_LINE}${this.bar.text}`);
    }

    /** Removes the progress bar, if one shows. */
    private endBar(): void {
        if (this.bar !== undefined) {
            this.bar.sink.stream.write(CLEAR_LINE);
            this.bar = undefined;
        }
    }
}

/** `3/10` for an event with a count, nothing without one. */
function countOf(event: ProgressEvent): string {
    return event.done === undefined ? "" : `${event.done}${event.total === undefined ? "" : `/${event.total}`}`;
}

/** The line a finished progress leaves behind: `  ✓ Downloading recipes 10/10`. */
function finishedLine(layout: Layout, event: ProgressEvent): string {
    const style = layout.style;
    const count = countOf(event);

    return `  ${style.green("✓")} ${event.label}${count === "" ? "" : ` ${style.value(count)}`}${event.item === undefined || event.item === "" ? "" : ` ${style.muted(event.item)}`}`;
}

/** The bar a terminal redraws: the label, a bar when the total is known, the count and the item being worked on. */
function barText(layout: Layout, event: ProgressEvent): string {
    const style = layout.style;
    const count = countOf(event);
    let bar = "";

    if (event.total !== undefined && event.total > 0 && event.done !== undefined) {
        const filled = Math.max(0, Math.min(BAR_CELLS, Math.round((BAR_CELLS * event.done) / event.total)));

        bar = ` ${style.cyan("█".repeat(filled))}${style.gray("░".repeat(BAR_CELLS - filled))}`;
    }

    const head = `  ${style.label(event.label)}${bar}${count === "" ? "" : ` ${style.value(count)}`}`;
    const room = layout.columns - 2 - displayWidth(head);

    if (event.item === undefined || event.item === "" || room < 6) {
        return head;
    }

    const item = event.item.length > room ? `${event.item.slice(0, room - 2)}…` : event.item;

    return `${head} ${style.muted(item)}`;
}
