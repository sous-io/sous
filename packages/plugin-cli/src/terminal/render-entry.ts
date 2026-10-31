import {
    type CommandDetails,
    type CountDetails,
    DataValue,
    errorChain,
    IntentOutputs,
    isSousError,
    ItemList,
    type IntentOutput,
    type LogLevel,
    type OperationAction,
    type OperationDetails,
    type OperationEndDetails,
    Payload,
    ReportEntryStyle,
    type ProblemDetails,
    type QuestionDetails,
    type ReportDetails,
    type ReportMessage,
    type ResolvedReferenceFacts,
    Table,
    TextBlock,
    Tree,
    type TreeNode,
    type VariableEntry,
    VariableSet,
} from "@sous-io/plugin-api";
import { HelpPage } from "../help-page.js";
import { renderBanner } from "../views/banner.js";
import { colorizeJson } from "../views/json.js";
import { formatResolvedReference } from "../views/ref-report.js";
import type { Paint } from "../views/style.js";
import { BULLET, wrapText } from "../views/text.js";
import { BLANK, ERROR_PREFIX, type Layout } from "./layout.js";

/** What the entries written so far tell the next one: whether a step of the current operation is open. */
export interface RenderState {
    step: boolean;
}

/** The lines of one entry, and the spacing it wants around them. */
export interface Rendered {
    /** The lines, each without a newline. */
    readonly lines: readonly string[];
    /** How many blank lines it wants above it (the reporter adds only the ones missing). */
    readonly gapBefore?: number;
    /** How many blank lines the next entry should have above it. */
    readonly gapAfter?: number;
    /** Whether the closing spacing a command ends with is wanted after it. */
    readonly footer?: boolean;
}

/** The words that open an entry at a level that is not an ordinary one. */
const LEVEL_PREFIX: Partial<Record<LogLevel, string>> = {
    debug: "Debug: ",
    warning: "Warning: ",
    error: ERROR_PREFIX,
    critical: "Critical: ",
    alert: "Alert: ",
    emergency: "Emergency: ",
};

/** How far the lines of an operation sit in: under its heading, and again under a step. */
const BODY_INDENT = 2;

/** The glyph, the words and the colors each action is shown with. */
const ACTIONS: Record<OperationAction, { glyph: string; word: string; keepNote: boolean }> = {
    written: { glyph: "✓", word: "", keepNote: false },
    unchanged: { glyph: "⊘", word: "unchanged", keepNote: false },
    "would-write": { glyph: "○", word: "would write", keepNote: false },
    skipped: { glyph: "⊘", word: "skipped", keepNote: true },
    failed: { glyph: "✗", word: "failed", keepNote: true },
    removed: { glyph: "−", word: "removed", keepNote: false },
    "would-remove": { glyph: "−", word: "would remove", keepNote: false },
};

/**
 * Turns one reported entry into terminal lines: every {@link ReportEntryStyle} has its own shape
 * here, so this is the one place that decides what the CLI's output looks like.
 *
 * @param layout - Builds the lines and holds the colors and the width.
 * @param state - Updated as operations and steps open and close.
 */
export function renderEntry(layout: Layout, state: RenderState, level: LogLevel, message: ReportMessage, details: ReportDetails | undefined, style: ReportEntryStyle): Rendered {
    if (IntentOutputs.is(message)) {
        return renderResult(layout, state, message);
    }

    if (message instanceof Error) {
        return renderError(layout, level, message);
    }

    const rendered = Payload.is(message) ? renderPayload(layout, level, message, style) : renderStyled(layout, state, level, String(message), details, style);

    return LEVEL_MARKED.has(style) || level === "debug" ? rendered : markLevel(layout, level, rendered);
}

/** Styles that show their own level (an operation by its glyph) or are not text about a problem: the shared level marking skips them. */
const LEVEL_MARKED = new Set<ReportEntryStyle>([
    ReportEntryStyle.Plain,
    ReportEntryStyle.Problem,
    ReportEntryStyle.Text,
    ReportEntryStyle.Data,
    ReportEntryStyle.Banner,
    ReportEntryStyle.Progress,
    ReportEntryStyle.Question,
    ReportEntryStyle.Operation,
]);

/**
 * At warning level and above, opens a styled entry's first line with the level's literal prefix in
 * the level's color (`Warning: `, `Error: `), so the entry reads as what it is with color off too.
 */
function markLevel(layout: Layout, level: LogLevel, rendered: Rendered): Rendered {
    const prefix = LEVEL_PREFIX[level];
    const at = rendered.lines.findIndex((line) => line.trim() !== "");

    if (prefix === undefined || at < 0) {
        return rendered;
    }

    const line = rendered.lines[at]!;
    const indent = line.length - line.trimStart().length;
    const lines = [...rendered.lines];

    lines[at] = `${line.slice(0, indent)}${levelPaint(layout, level)(prefix)}${line.slice(indent)}`;

    return { ...rendered, lines, gapBefore: Math.max(rendered.gapBefore ?? 0, 1) };
}

/** A message that is plain text, drawn by its style; the facts a style carries are in `details`. */
function renderStyled(layout: Layout, state: RenderState, level: LogLevel, message: string, details: ReportDetails | undefined, style: ReportEntryStyle): Rendered {
    const colors = layout.style;
    const body = BODY_INDENT + (state.step ? BODY_INDENT : 0);
    const pad = (count: number) => " ".repeat(count);

    switch (style) {
        case ReportEntryStyle.Text:
            return verbatim(message);

        case ReportEntryStyle.Banner:
            return { lines: renderBanner(colors).replace(/\n$/, "").split("\n") };

        case ReportEntryStyle.Note:
            return { lines: layout.noteLines(message), footer: true };

        case ReportEntryStyle.OperationStart:
            state.step = false;

            return { lines: [layout.heading(message)], gapBefore: 1, gapAfter: 1, footer: true };

        case ReportEntryStyle.StepStart:
            state.step = true;

            return { lines: [`${pad(BODY_INDENT)}${colors.subheading(`▷ ${message}`)}`], gapBefore: 1, footer: true };

        case ReportEntryStyle.Detail:
            return { lines: layout.paragraphLines(message, { indent: body, color: levelPaint(layout, level) }), footer: true };

        case ReportEntryStyle.Operation:
            return operation(layout, details as OperationDetails | undefined, message, body);

        case ReportEntryStyle.OperationEnd: {
            const ok = (details as OperationEndDetails | undefined)?.ok !== false;

            state.step = false;

            return { lines: layout.paragraphLines(message, { indent: 0, color: ok ? colors.greenBright : colors.error }), gapBefore: 1, footer: true };
        }

        case ReportEntryStyle.Count: {
            const count = details as CountDetails | undefined;

            return count === undefined ? plain(layout, level, message) : { lines: [layout.countLine(count.count, count.entity, count.verb)], footer: true };
        }

        case ReportEntryStyle.DryRun:
            return { lines: layout.dryRunLines(message), footer: true };

        case ReportEntryStyle.Problem: {
            const problem = details as ProblemDetails | undefined;

            return problem === undefined ? plain(layout, level, message) : problemEntry(layout, level, problem);
        }

        case ReportEntryStyle.ResolvedReference: {
            const facts = details as ResolvedReferenceFacts | undefined;

            return facts === undefined || typeof facts.resolvedTo !== "string"
                ? plain(layout, level, message)
                : { lines: formatResolvedReference(facts, message, colors, layout.columns), gapAfter: 1, footer: true };
        }

        case ReportEntryStyle.Question: {
            const question = details as QuestionDetails | undefined;

            return question === undefined ? plain(layout, level, message) : questionEntry(layout, question);
        }

        case ReportEntryStyle.Command: {
            const command = details as CommandDetails | undefined;

            if (command === undefined) {
                return plain(layout, level, message);
            }

            const line = [command.command, ...command.args].join(" ");
            const where = command.cwd === undefined ? "" : ` ${colors.muted(`(in ${command.cwd})`)}`;

            return { lines: [`${pad(BODY_INDENT)}${colors.label(command.dryRun === true ? "Would run" : "Running")}: ${colors.value(line)}${where}`], footer: true };
        }

        case ReportEntryStyle.Progress:
        case ReportEntryStyle.Plain:
            return plain(layout, level, message);

        default:
            return plain(layout, level, message);
    }
}

/** Text exactly as given, one line per line of text (a trailing newline ends the last line; none for empty text). */
function verbatim(text: string): Rendered {
    return { lines: text === "" ? [] : text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n") };
}

/**
 * Draws a payload (`VariableSet`, `Table`, ...) by its kind, whether it came as a message while an
 * intent runs or as the result of an output. `style` says what the entry is where the payload alone
 * does not (`CommandVariables`, `Note`, `DryRun`, `Text`). Only the payload's own fields are read.
 */
function renderPayload(layout: Layout, level: LogLevel, payload: Payload, style: ReportEntryStyle): Rendered {
    const colors = layout.style;

    if (payload instanceof VariableSet) {
        if (style === ReportEntryStyle.CommandVariables) {
            return payload.entries.length === 0
                ? { lines: [] }
                : { lines: [layout.subheading(payload.title ?? "Command Variables", "$"), ...layout.variableLines(payload.entries)], gapBefore: 1, footer: true };
        }

        const titled = payload.title !== undefined;

        return { lines: [...(titled ? [layout.subheading(payload.title!)] : []), ...layout.variableLines(payload.entries)], gapBefore: titled ? 1 : 0, footer: true };
    }

    if (payload instanceof Table) {
        return tableEntry(layout, payload);
    }

    if (payload instanceof ItemList) {
        return { lines: listLines(layout, payload), footer: true };
    }

    if (payload instanceof Tree) {
        return treeEntry(layout, payload);
    }

    if (payload instanceof DataValue) {
        const json = payload.toText();

        return { lines: (colors.enabled ? colorizeJson(json, colors) : json).split("\n") };
    }

    if (payload instanceof HelpPage) {
        return verbatim(payload.render(colors));
    }

    if (payload instanceof TextBlock) {
        if (style === ReportEntryStyle.Note) {
            return { lines: layout.noteLines(payload.text), footer: true };
        }

        if (style === ReportEntryStyle.DryRun) {
            return { lines: layout.dryRunLines(payload.text), footer: true };
        }

        return payload.verbatim || style === ReportEntryStyle.Text ? verbatim(payload.text) : plain(layout, level, payload.text);
    }

    return plain(layout, level, payload.toText());
}

/**
 * A command's result: each output in order. Its title is a heading, its summary a paragraph, then
 * its result payload. Between two parts, the blank lines the one before wants after it or the one
 * after wants before it, whichever is more.
 */
function renderResult(layout: Layout, state: RenderState, outputs: IntentOutputs<object>): Rendered {
    return joinRendered(outputs.toArray().flatMap((output) => renderOutput(layout, state, output)));
}

/** The parts of one output. */
function renderOutput(layout: Layout, state: RenderState, output: IntentOutput): Rendered[] {
    const parts: Rendered[] = [];
    const style = output.style ?? ReportEntryStyle.Plain;
    const block = style === ReportEntryStyle.CommandVariables && output.result instanceof VariableSet;

    if (output.title !== undefined && !block) {
        state.step = false;
        parts.push({ lines: [layout.heading(output.title)], gapBefore: 1, gapAfter: 1, footer: true });
    }

    if (block) {
        const set = output.result as VariableSet;

        parts.push(renderPayload(layout, "info", new VariableSet(set.entries, { title: output.title ?? set.title ?? "Command Variables" }), style));
    }

    if (output.summary !== undefined) {
        parts.push({ lines: layout.paragraphLines(output.summary), footer: true });
    }

    if (output.result !== undefined && !block) {
        parts.push(renderPayload(layout, "info", output.result, style));
    }

    return parts;
}

/** Puts rendered parts one after another with the blank lines between them they ask for. */
function joinRendered(parts: readonly Rendered[]): Rendered {
    const shown = parts.filter((part) => part.lines.length > 0);
    const lines: string[] = [];

    shown.forEach((part, index) => {
        const gap = index === 0 ? 0 : Math.max(shown[index - 1]!.gapAfter ?? 0, part.gapBefore ?? 0);

        lines.push(...Array.from({ length: gap }, () => BLANK), ...part.lines);
    });

    const first = shown[0];
    const last = shown[shown.length - 1];

    return {
        lines,
        ...(first?.gapBefore === undefined ? {} : { gapBefore: first.gapBefore }),
        ...(last?.gapAfter === undefined ? {} : { gapAfter: last.gapAfter }),
        ...(shown.some((part) => part.footer === true) ? { footer: true } : {}),
    };
}

/**
 * An error and the errors under it. The first line is the message in the level's color, with the
 * level's prefix; a failure that ends the run (`critical`) is the CLI's "Error: ". Under it, the
 * error's `details`, then each cause as "Caused by: ..." with its own details one step deeper.
 *
 * ```text
 * Error: Could not add the repository.
 *   Check the URL.
 *   Caused by: getaddrinfo ENOTFOUND example.com
 * ```
 */
function renderError(layout: Layout, level: LogLevel, error: Error): Rendered {
    const colors = layout.style;
    const paint = level === "debug" ? colors.muted : levelPaint(layout, level);
    const prefix = level === "critical" ? ERROR_PREFIX : (LEVEL_PREFIX[level] ?? "");
    const indented = (text: string, depth: number) =>
        text
            .split("\n")
            .flatMap((line) => (line.trim() === "" ? [BLANK] : wrapText(`${" ".repeat(depth)}${line}`, layout.wrapWidth, { hangingIndent: 2 }).map((wrapped) => paint(wrapped))));
    const detailsOf = (each: Error, depth: number) => (isSousError(each) ? each.details.flatMap((detail) => indented(detail, depth)) : []);
    const [first, ...causes] = errorChain(error);
    const lines = [...wrapText(`${prefix}${first!.message}`, layout.wrapWidth).map((line) => paint(line)), ...detailsOf(first!, 2)];

    for (const cause of causes) {
        lines.push(...indented(`Caused by: ${cause.message}`, 2), ...detailsOf(cause, 4));
    }

    return level === "warning" ? { lines, gapBefore: 1, gapAfter: 1 } : { lines, gapBefore: 1 };
}

/** The color a level paints its text with: yellow for a warning, red for an error or worse, none otherwise. */
export function levelPaint(layout: Layout, level: LogLevel): Paint {
    if (level === "warning") {
        return layout.style.warning;
    }

    return isErrorLevel(level) ? layout.style.error : (text) => text;
}

/** Whether a level is `error` or more severe. */
export function isErrorLevel(level: LogLevel): boolean {
    return level === "error" || level === "critical" || level === "alert" || level === "emergency";
}

/**
 * A paragraph. A warning gets the `WARNING:` banner, an error its literal prefix (`Error: `), so
 * both stay findable with color off.
 */
function plain(layout: Layout, level: LogLevel, message: string): Rendered {
    if (level === "warning") {
        return { lines: layout.warningLines(message), gapBefore: 1, gapAfter: 1 };
    }

    if (isErrorLevel(level)) {
        return { lines: layout.errorLines(message, LEVEL_PREFIX[level] ?? ERROR_PREFIX), gapBefore: 1 };
    }

    if (level === "debug") {
        return { lines: layout.paragraphLines(`${LEVEL_PREFIX.debug}${message}`, { indent: 0, color: layout.style.muted }) };
    }

    return { lines: layout.paragraphLines(message), footer: true };
}

/** One action done to one target: a glyph, the target, and a few words in grey. */
function operation(layout: Layout, details: OperationDetails | undefined, message: string, body: number): Rendered {
    if (details === undefined) {
        return plain(layout, "info", message);
    }

    const colors = layout.style;
    const action = ACTIONS[details.action];
    const parts: string[] = [];

    if (details.tokens !== undefined) {
        parts.push(`~${details.tokens.toLocaleString()} tokens`);
    }

    if (action.keepNote) {
        parts.push(details.note ?? action.word);
    } else {
        if (action.word !== "") {
            parts.push(action.word);
        }

        if (details.note !== undefined) {
            parts.push(details.note);
        }
    }

    const [glyph, target] = ((): [string, string] => {
        switch (details.action) {
            case "written":
                return [colors.green(action.glyph), colors.value(details.target)];
            case "would-write":
                return [colors.yellow(action.glyph), details.target];
            case "failed":
                return [colors.red(action.glyph), colors.error(details.target)];
            case "removed":
            case "would-remove":
                return [colors.yellow(action.glyph), details.target];
            default:
                return [colors.muted(action.glyph), colors.muted(details.target)];
        }
    })();
    const suffix = parts.length === 0 ? "" : ` ${colors.muted(`(${parts.join("; ")})`)}`;

    return { lines: [`${" ".repeat(body)}${glyph} ${target}${suffix}`], footer: true };
}

/** A list: its title, bullets, and a closing sentence. */
function listLines(layout: Layout, list: ItemList): string[] {
    const colors = layout.style;
    const lines: string[] = [];
    const indentBy = 4;

    if (list.title !== undefined) {
        lines.push(...layout.paragraphLines(list.title));
    }

    for (const item of list.items) {
        wrapText(`${BULLET} ${item}`, Math.max(20, layout.wrapWidth - indentBy), { hangingIndent: 2 }).forEach((line, index) => {
            lines.push(`${" ".repeat(indentBy)}${index === 0 ? colors.cyan(BULLET) + line.slice(BULLET.length) : line}`);
        });
    }

    if (list.footer !== undefined) {
        lines.push(BLANK, ...layout.paragraphLines(list.footer));
    }

    return lines;
}

/** A table under an optional title, or the sentence for having no rows. */
function tableEntry(layout: Layout, table: Table): Rendered {
    const titled = table.title === undefined ? [] : [layout.subheading(table.title)];

    if (table.rows.length === 0 && table.empty !== undefined) {
        return { lines: [...titled, ...layout.paragraphLines(table.empty)], gapBefore: titled.length, footer: true };
    }

    const notes = table.rowNotes;
    const lines = layout.tableLines([...table.columns], [...table.rows], {
        indent: 2,
        ...(notes === undefined ? {} : { rowNote: (_row: Record<string, unknown>, index: number) => (notes[index] === undefined ? undefined : layout.style.muted(`  ${notes[index]}`)) }),
    });

    return { lines: [...titled, ...lines], gapBefore: titled.length, footer: true };
}

/** A problem: its summary in the level's color, then where, why and what to do, indented under it. */
function problemEntry(layout: Layout, level: LogLevel, problem: ProblemDetails): Rendered {
    const colors = layout.style;
    const paint = levelPaint(layout, level);
    const prefix = LEVEL_PREFIX[level] ?? "";
    const lines = wrapText(`${prefix}${problem.summary}`, layout.wrapWidth).map((line) => paint(line));
    const indented = (text: string, color: Paint) =>
        text
            .split("\n")
            .flatMap((line) => (line.trim() === "" ? [BLANK] : wrapText(`  ${line}`, layout.wrapWidth, { hangingIndent: 2 }).map((wrapped) => color(wrapped))));

    if (problem.subject !== undefined) {
        lines.push(...indented(`In ${problem.subject}${problem.line === undefined ? "" : `, line ${problem.line}`}`, colors.muted));
    }

    if (problem.cause !== undefined) {
        lines.push(...indented(problem.cause, paint));
    }

    if (problem.hint !== undefined) {
        lines.push(...indented(problem.hint, colors.note));
    }

    return level === "warning" ? { lines, gapBefore: 1, gapAfter: 1 } : { lines, gapBefore: 1 };
}

/** The header of a question: where it is in the run, what it is, and the facts about its answer. */
function questionEntry(layout: Layout, question: QuestionDetails): Rendered {
    const colors = layout.style;
    const facts: VariableEntry[] = [
        ["Example", question.example],
        ["Recipe", question.recipe],
        ["Stored in", question.storedIn],
        ["Stored as", question.storedAs],
    ]
        .filter((fact): fact is [string, string] => fact[1] !== undefined)
        .map(([label, value]) => ({ label, value }));
    const lines = [`  ${colors.bold(`Question ${question.index} of ${question.total}: ${colors.cyan(question.name)}`)}`];

    if (question.description !== undefined && question.description !== "") {
        lines.push(BLANK, ...layout.paragraphLines(question.description, { hangingIndent: 0 }));
    }

    if (facts.length > 0) {
        lines.push(BLANK, ...layout.variableLines(facts));
    }

    return { lines, gapBefore: 2, gapAfter: 1 };
}

/** Nested items under an optional title: two spaces per level, a detail in grey after the label. */
function treeEntry(layout: Layout, tree: Tree): Rendered {
    const colors = layout.style;
    const lines: string[] = tree.title === undefined ? [] : [layout.subheading(tree.title)];
    const walk = (nodes: readonly TreeNode[], depth: number): void => {
        for (const node of nodes) {
            const detail = node.detail === undefined || node.detail === "" ? "" : ` ${colors.muted(node.detail)}`;

            lines.push(`${" ".repeat(BODY_INDENT * (depth + 1))}${colors.cyan(BULLET)} ${colors.value(node.label)}${detail}`);
            walk(node.children ?? [], depth + 1);
        }
    };

    walk(tree.nodes, 0);

    return { lines, gapBefore: tree.title === undefined ? 0 : 1, footer: true };
}
