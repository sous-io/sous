/**
 * The pieces every recipe intent builds its outputs from: sentences, notes, lists, tables, the
 * questions a subscription would ask, and the outputs of the intents a handler ran afterwards
 * (`vars.ask`, `build`).
 *
 * An intent returns `IntentOutputs`; these helpers keep the way each part is shown the same in
 * every intent. A heading is an output's `title`, a sentence its `summary`, a note or dry-run
 * sentence a `TextBlock` with the matching style.
 */

import {
    IntentOutput,
    IntentOutputs,
    ItemList,
    ReportEntryStyle,
    Table,
    TextBlock,
    VariableSet,
    type Context,
    type TableColumn,
    type VariableEntry,
} from "@sous-io/plugin-api";
import type { IntentFollowUp, LockDiff, PlannedQuestion, PlannedQuestions } from "../types.js";

// --- Single outputs ---------------------------------------------------------------------------------

/** One sentence, optionally under a heading. */
export function sentence(summary: string, title?: string): IntentOutput {
    return new IntentOutput({ ...(title === undefined ? {} : { title }), summary });
}

/** An explanation that is neither a warning nor an error. */
export function noteOutput(text: string, title?: string): IntentOutput {
    return new IntentOutput({ ...(title === undefined ? {} : { title }), result: new TextBlock(text), style: ReportEntryStyle.Note });
}

/** A sentence saying what a dry run did not do, or would do. */
export function dryRunOutput(text: string, title?: string): IntentOutput {
    return new IntentOutput({ ...(title === undefined ? {} : { title }), result: new TextBlock(text), style: ReportEntryStyle.DryRun });
}

/** One line of detail. */
export function detailOutput(text: string, title?: string): IntentOutput {
    return new IntentOutput({ ...(title === undefined ? {} : { title }), result: new TextBlock(text), style: ReportEntryStyle.Detail });
}

/** A list of items; `listTitle` is shown with the list, `heading` above it. */
export function listOutput(items: readonly string[], options: { heading?: string; listTitle?: string } = {}): IntentOutput {
    return new IntentOutput({
        ...(options.heading === undefined ? {} : { title: options.heading }),
        result: new ItemList(items, options.listTitle === undefined ? {} : { title: options.listTitle }),
    });
}

/** Labels and values as one block; `blockTitle` is shown with the block, `heading` above it. */
export function blockOutput(entries: readonly VariableEntry[] | Readonly<Record<string, unknown>>, options: { heading?: string; blockTitle?: string } = {}): IntentOutput {
    return new IntentOutput({
        ...(options.heading === undefined ? {} : { title: options.heading }),
        result: new VariableSet(entries, options.blockTitle === undefined ? {} : { title: options.blockTitle }),
    });
}

/** A table; `tableTitle` is shown with the table, `heading` above it. */
export function tableOutput(
    columns: readonly TableColumn[],
    rows: readonly Readonly<Record<string, unknown>>[],
    options: { heading?: string; tableTitle?: string; empty?: string; rowNotes?: readonly (string | undefined)[] } = {},
): IntentOutput {
    return new IntentOutput({
        ...(options.heading === undefined ? {} : { title: options.heading }),
        result: new Table(columns, rows, {
            ...(options.tableTitle === undefined ? {} : { title: options.tableTitle }),
            ...(options.empty === undefined ? {} : { empty: options.empty }),
            ...(options.rowNotes === undefined ? {} : { rowNotes: options.rowNotes }),
        }),
    });
}

// --- Headings ---------------------------------------------------------------------------------------

/** The same output under another title. */
function retitled(output: IntentOutput, title: string): IntentOutput {
    return new IntentOutput({
        title,
        ...(output.summary === undefined ? {} : { summary: output.summary }),
        ...(output.result === undefined ? {} : { result: output.result }),
        ...(output.data === undefined ? {} : { data: output.data }),
        ...(output.style === undefined ? {} : { style: output.style }),
    });
}

/**
 * Outputs under a heading: the heading becomes the first output's title, or an output of its own
 * when the first one has a title already.
 */
export function underHeading(heading: string, outputs: readonly IntentOutput[]): IntentOutput[] {
    const [first, ...rest] = outputs;

    if (first === undefined) {
        return [new IntentOutput({ title: heading })];
    }

    return first.title === undefined ? [retitled(first, heading), ...rest] : [new IntentOutput({ title: heading }), first, ...rest];
}

// --- Finishing --------------------------------------------------------------------------------------

/**
 * The outputs an intent returns. `data` is what machines get (`toPlain()` of the outputs is the
 * last output's), so it goes on the last output of `own`; when `after` outputs follow (the ones of
 * a follow-up intent), a last output holding only `data` closes them, which shows nothing.
 */
export function finish<T extends object>(own: readonly IntentOutput[], data: T, options: { after?: readonly IntentOutput[]; exitCode?: number } = {}): IntentOutputs<T> {
    const after = options.after ?? [];
    const exit = options.exitCode === undefined ? {} : { exitCode: options.exitCode };
    const last = own[own.length - 1];

    if (after.length === 0 && last !== undefined) {
        const closing = new IntentOutput<T>({
            ...(last.title === undefined ? {} : { title: last.title }),
            ...(last.summary === undefined ? {} : { summary: last.summary }),
            ...(last.result === undefined ? {} : { result: last.result }),
            ...(last.style === undefined ? {} : { style: last.style }),
            data,
        });

        return new IntentOutputs<T>([...own.slice(0, -1), closing], exit);
    }

    return new IntentOutputs<T>([...own, ...after, new IntentOutput<T>({ data })], exit);
}

// --- Follow-up intents ------------------------------------------------------------------------------

/** An intent a handler ran afterwards, with the outputs it gave (kept out of the machine data). */
export interface RanFollowUp extends IntentFollowUp {
    readonly outputs?: IntentOutputs<object>;
}

/** The follow-ups as machine data: what each ran and gave, without its outputs. */
export function plainFollowUps(followUps: readonly IntentFollowUp[]): IntentFollowUp[] {
    return followUps.map((entry) => ({ intent: entry.intent, ...(entry.result === undefined ? {} : { result: entry.result }), ...(entry.skipped === undefined ? {} : { skipped: entry.skipped }) }));
}

/** The result with its follow-ups as machine data. */
export function plainResult<T extends { readonly followUps: IntentFollowUp[] }>(result: T): T {
    return { ...result, followUps: plainFollowUps(result.followUps) };
}

/** The follow-up of one intent, if there is one. */
export function followUpOf(result: { readonly followUps?: readonly IntentFollowUp[] }, intent: string): RanFollowUp | undefined {
    return result.followUps?.find((entry) => entry.intent === intent);
}

/** Whether a follow-up build ran (it did not when skipped by `--no-build` or `--dry-run`). */
export function rebuilt(result: { readonly followUps?: readonly IntentFollowUp[] }): boolean {
    const build = followUpOf(result, "build");

    return build !== undefined && build.skipped === undefined;
}

/** Whether the outputs of a build say it failed. */
function buildFailed(entry: RanFollowUp): boolean {
    return (entry.outputs?.exitCode ?? 0) !== 0 || (entry.result as { ok?: unknown } | undefined)?.ok === false;
}

/**
 * The outputs of the follow-ups that ran, in order (`vars.ask` under "Variables", then the build),
 * and whether the build failed.
 */
export function followUpOutputs(result: { readonly followUps?: readonly IntentFollowUp[] }): { outputs: IntentOutput[]; failed: boolean } {
    const outputs: IntentOutput[] = [];
    let failed = false;

    for (const entry of (result.followUps ?? []) as readonly RanFollowUp[]) {
        if (entry.skipped !== undefined || entry.outputs === undefined) {
            continue;
        }

        const shown = entry.outputs.toArray();

        outputs.push(...(entry.intent === "vars.ask" ? underHeading("Variables", shown) : shown));

        if (entry.intent === "build" && buildFailed(entry)) {
            failed = true;
        }
    }

    return { outputs, failed };
}

/**
 * Finishes an intent that ran follow-ups: its own outputs, then the follow-ups' outputs; a failed
 * build is reported with `failedMessage` and ends the command with exit code 1.
 */
export function finishWithFollowUps<T extends { readonly followUps: IntentFollowUp[] }>(
    ctx: Pick<Context, "reporter">,
    own: readonly IntentOutput[],
    result: T,
    failedMessage: string,
): IntentOutputs<T> {
    const { outputs, failed } = followUpOutputs(result);

    if (failed) {
        ctx.reporter.error(failedMessage);
    }

    return finish(own, plainResult(result), { after: outputs, ...(failed ? { exitCode: 1 } : {}) });
}

// --- Words ------------------------------------------------------------------------------------------

/**
 * A lockfile diff as plain-language lines, one per change.
 *
 * ```ts
 * lockDiffLines({ added: [{ key: "core/a", to: "1.0.0" }], ... }); // ["Adding core/a version 1.0.0"]
 * ```
 */
export function lockDiffLines(diff: LockDiff): string[] {
    const byKey = (left: { key: string }, right: { key: string }) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    const lines = [
        ...diff.reposAdded.map((name) => `Repository added: ${name}`),
        ...[...diff.added].sort(byKey).map((change) => `Adding ${change.key} version ${change.to}`),
        ...[...diff.updated].sort(byKey).map((change) => `Updating ${change.key} from version ${change.from} to version ${change.to}`),
        ...[...diff.removed].sort(byKey).map((change) => `Removing ${change.key}, which nothing needs any more`),
        ...diff.reposRemoved.map((name) => `Repository no longer needed: ${name}`),
    ];

    return lines.length === 0 ? ["Nothing changed."] : lines;
}

/** The lockfile section: the diff's lines, or `whenUnchanged`. */
export function lockfileOutput(diff: LockDiff, whenUnchanged: string): IntentOutput {
    return diff.unchanged ? sentence(whenUnchanged, "Lockfile") : listOutput(lockDiffLines(diff), { heading: "Lockfile" });
}

/** A byte count the way a person reads one. */
export function describeSize(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} bytes`;
    }

    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }

    return `${value.toFixed(1)} ${units[unit]}`;
}

/** The first sentence of a description. */
export function firstSentence(text: string): string {
    const match = /^.*?[.!?](?=\s|$)/s.exec(text.trim());

    return (match?.[0] ?? text.trim()).replace(/\s+/g, " ");
}

// --- The questions some recipes would ask -------------------------------------------------------------

function questionCount(count: number): string {
    return count === 1 ? "1 question" : `${count} questions`;
}

/**
 * The facts one question shows: what it is for, its example, where its answer goes, whether it has
 * one, and (with `answerHint`) the flag that answers it.
 */
export function questionFacts(question: PlannedQuestion, answerHint: boolean): VariableEntry[] {
    const variable = question.definition;
    const entries: VariableEntry[] = [];

    if (variable.description !== undefined && variable.description !== "") {
        entries.push({ label: "about", value: firstSentence(variable.description) });
    }

    if (variable.example !== undefined) {
        entries.push({ label: "example", value: String(variable.example) });
    }

    if (question.storedAs !== undefined && question.storedAs !== "") {
        entries.push({ label: "stored-as", value: question.storedAs });
    }

    if (question.storagePath !== undefined && question.storagePath !== "") {
        entries.push({ label: "storage-path", value: question.storagePath });
    }

    entries.push({
        label: "answered",
        value: question.answered
            ? `yes${question.answeredFrom === undefined ? "" : `, from ${question.answeredFrom}`}`
            : variable.required === false
              ? "no, and an answer is optional"
              : "no, and this recipe requires an answer",
    });

    if (answerHint) {
        entries.push({ label: "answer-with", value: `--answer ${variable.name}=<value>` });
    }

    return entries;
}

/**
 * The questions some recipes would ask, grouped by recipe. `answerHints` adds the flag that answers
 * each question and the closing sentence about answering ahead of time.
 */
export function questionPlanOutputs(plan: PlannedQuestions, options: { answerHints: boolean }): IntentOutput[] {
    const count = plan.questions.length;
    const unanswered = plan.questions.filter((question) => !question.answered).length;
    const unreadable =
        plan.unreadable.length === 0
            ? undefined
            : `Not on this machine yet, and their repository's index does not record their questions, so they cannot be listed: ${plan.unreadable.join(", ")}.` +
              (options.answerHints ? " A dry run downloads nothing; run this command again without '--dry-run' to install them and be asked." : "");

    if (count === 0) {
        return [unreadable === undefined ? sentence("None of these recipes ask any questions, so nothing needs answering.") : noteOutput(unreadable)];
    }

    const subject = plan.unreadable.length === 0 ? "These recipes ask" : "The recipes sous could read ask";
    const outputs: IntentOutput[] = [
        sentence(
            unanswered === 0
                ? `${subject} ${questionCount(count)}, and everything they ask is already answered.`
                : `${subject} ${questionCount(count)}, ${unanswered} of which nothing answers yet.`,
        ),
    ];
    const groups = new Map<string, PlannedQuestion[]>();

    for (const question of plan.questions) {
        groups.set(question.recipe, [...(groups.get(question.recipe) ?? []), question]);
    }

    for (const [recipe, questions] of groups) {
        questions.forEach((question, index) => {
            outputs.push(blockOutput(questionFacts(question, options.answerHints), { blockTitle: question.definition.name, ...(index === 0 ? { heading: `${recipe} asks ${questionCount(questions.length)}:` } : {}) }));
        });
    }

    if (unreadable !== undefined) {
        outputs.push(noteOutput(unreadable));
    }

    if (options.answerHints && unanswered > 0) {
        outputs.push(noteOutput("Answer them all ahead of time by running this command again without '--dry-run', with one '--answer <name>=<value>' for each, or with '--answers-file <path>'."));
    }

    return outputs;
}
