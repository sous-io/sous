/**
 * Applying the master list (spec 07, spec 08, spec 12). For every file the declared entries and
 * the history name, in one pass over the document:
 *
 * 1. Undo the entries no longer declared (only after a config build that succeeded), last applied
 *    first, each operation's `down` from what its `up` recorded. `rollback: false` skips this.
 * 2. Apply every declared entry, in config order, so a later entry wins. An entry applied before
 *    with `once`, and an action applied before (`append`), are not applied again.
 * 3. Remove a file Sous created when no declared entry names it any more (copied to
 *    `.sous/backups/` first, unless `backupOnRemoval: false`).
 * 4. Run the assertions on the document as it is about to be written: the authors', and the
 *    automatic ones (level warn), minus duplicates and silenced ones.
 * 5. Write the file once, unless an assertion at level error failed (not ignored).
 *
 * Folders come first (created before the files in them) and last (removed after them, deepest
 * first, only when Sous created them and they are empty). Edits never fail the build; a file that
 * cannot be parsed is skipped with a warning, and its assertions fail. What Sous did is said only
 * in debug output.
 */

import fs from "node:fs";
import path from "node:path";
import { getAtPath, isJsonObject, parsePath, pathsOverlap, isPathPrefix, type JsonValue } from "@sous-io/documents";
import type { Reporter } from "@sous-io/plugin-api";
import { describeCheck, normalizeKind, runCheck, show, type CheckSubject } from "./checks.js";
import { formatForFile } from "./documents-adapter.js";
import type { AuthoredAssertion, EntrySettings, Silence } from "./entries.js";
import { fromStored, readHistory, toStored, writeHistory } from "./history.js";
import { EditNotPossible, type OperationContext, type ResolvedOperation } from "./operations.js";
import { FileSession, UnparseableFileError } from "./session.js";
import type { AssertionOutcome, EditedFile, EditorApplyResult, EditorHistory, HistoryEntry, HistoryStep } from "./types.js";

/** One declared entry, ready to apply: who declared it, its file (absolute), and its parts. */
export interface DeclaredEntry {
    readonly identity: string;
    readonly declarer: string;
    /** Absolute; `undefined` for an `ensureDirectoryExists` entry. */
    readonly file: string | undefined;
    readonly settings: EntrySettings;
    readonly steps: readonly ResolvedOperation[];
    readonly asserts: readonly AuthoredAssertion[];
    readonly silences: readonly Silence[];
}

/** What applying needs from its surroundings. */
export interface ApplyEnvironment {
    readonly projectRoot: string;
    readonly historyFile: string;
    readonly reporter: Reporter;
    /** Copies a file to `.sous/backups/<date-time>/<path>`; returns where it went. */
    backup(file: string): string;
    /** Counts tokens (`o200k_base`). */
    countTokens(text: string): Promise<number>;
    readonly now?: () => Date;
}

/** How to apply. */
export interface ApplyOptions {
    readonly dryRun?: boolean;
    readonly ignoreFailedAssertions?: boolean;
    /** Whether entries no longer declared may be undone: only after a config build that succeeded. */
    readonly undo: boolean;
}

/** The operations that edit the text itself when they act at the root, so the file need not parse. */
const TEXT_OPERATIONS = new Set(["ensureLine", "removeLine", "ensureBlock", "appendText", "prependText", "replaceText", "replacePattern"]);

/** Checks that pass on a missing file when an edit made them (nothing is there, so nothing wrong is there). */
const NEGATIVE_CHECKS = new Set(["noItemWhere", "excludes"]);

function needsDocument(step: { op: string; params: Record<string, unknown> } | ResolvedOperation): boolean {
    const name = "definition" in step ? step.definition.name : step.op;
    const target = "definition" in step ? step.path : ((step.params.path as string | undefined) ?? "");

    if (name === "ensureFileExists" || name === "ensureDirectoryExists") return false;

    return !(TEXT_OPERATIONS.has(name) && target === "");
}

function readText(file: string): string | undefined {
    try {
        return fs.readFileSync(file, "utf8");
    } catch {
        return undefined;
    }
}

function isDirectory(dir: string): boolean {
    try {
        return fs.statSync(dir).isDirectory();
    } catch {
        return false;
    }
}

/** The main parameter of a step, for the history of a value in a failure. */
function mainValue(step: { params: Record<string, unknown> }): string {
    const params = step.params as Record<string, JsonValue>;

    for (const key of ["value", "items", "item", "line", "match", "where", "values", "content", "name", "keys"]) {
        if (params[key] !== undefined) return show(params[key]);
    }

    return "";
}

/** One edit made to a value this run, for the history in a failure. */
interface ValueEvent {
    readonly path: string;
    readonly declarer: string;
    readonly operation: string;
    readonly value: string;
}

/** An assertion to run. */
interface PendingAssertion {
    readonly path: string;
    readonly check: string;
    readonly arg: JsonValue;
    readonly not: boolean;
    readonly declarer: string;
    readonly level: "error" | "warn";
    readonly message: string | undefined;
    readonly automatic: boolean;
}

/** Whether a silence covers an automatic assertion of this kind at this path. */
export function silenceCovers(silence: Silence, path: string, kind: string): boolean {
    const at = parsePath(silence.path);
    const target = parsePath(path);
    const equal = at.length === target.length && isPathPrefix(at, target);
    const reaches =
        silence.scope === "key-only" ? equal : silence.scope === "below" ? !equal && isPathPrefix(at, target) : isPathPrefix(at, target);

    if (!reaches) return false;

    const normalized = normalizeKind(kind);

    if (silence.kinds !== undefined) return silence.kinds.includes(normalized);
    if (silence.except !== undefined) return !silence.except.includes(normalized);

    return true;
}

/** Directories: each missing level of each folder, created top down; returns those created. */
export function createDirectories(dirs: readonly string[], dryRun: boolean): string[] {
    const created: string[] = [];

    for (const dir of dirs) {
        const missing: string[] = [];
        let current = path.resolve(dir);

        while (!isDirectory(current) && !created.includes(current)) {
            missing.unshift(current);

            const parent = path.dirname(current);

            if (parent === current) break;

            current = parent;
        }

        for (const level of missing) {
            if (!dryRun) fs.mkdirSync(level);
            created.push(level);
        }
    }

    return created;
}

/** Removes folders Sous created that are empty, deepest first; returns those removed. */
export function removeEmptyDirectories(dirs: readonly string[], dryRun: boolean): string[] {
    const removed: string[] = [];
    const ordered = [...new Set(dirs)].sort((a, b) => b.split(path.sep).length - a.split(path.sep).length || (a < b ? 1 : -1));

    for (const dir of ordered) {
        if (!isDirectory(dir)) continue;

        const left = fs.readdirSync(dir).filter((name) => !removed.includes(path.join(dir, name)));

        if (left.length > 0) continue;

        if (!dryRun) fs.rmdirSync(dir);
        removed.push(dir);
    }

    return removed;
}

/** Runs one operation's `up`, combining its record with the earlier run's. */
function runUp(step: ResolvedOperation, ctx: OperationContext, previous: HistoryStep | undefined): JsonValue {
    const record = step.definition.up(ctx, step.params, previous?.record);

    if (previous === undefined) return record;
    if (step.definition.mergeRecords) return step.definition.mergeRecords(previous.record, record);

    return record;
}

function contextFor(session: FileSession, step: { path: string }): OperationContext {
    return {
        session,
        path: step.path,
        node: () => session.document().atPath(step.path),
    };
}

function stepPath(step: HistoryStep): string {
    return typeof step.params.path === "string" ? step.params.path : "";
}

/** The file as a person reads it in a message: relative to the project root when inside it. */
function display(file: string, root: string): string {
    return toStored(file, root);
}

/**
 * Applies the declared entries and undoes the ones no longer declared, then writes each file once
 * and keeps the history.
 */
export async function applyEdits(
    declared: readonly DeclaredEntry[],
    env: ApplyEnvironment,
    options: ApplyOptions,
    lookup: (op: string) => ResolvedOperation["definition"] | undefined,
): Promise<EditorApplyResult> {
    const { projectRoot: root, reporter } = env;
    const dryRun = options.dryRun === true;
    const history = readHistory(env.historyFile, root);
    const declaredIds = new Set(declared.map((entry) => entry.identity));
    const previousById = new Map(history.entries.map((entry) => [entry.identity, entry]));
    const undeclared = history.entries.filter((entry) => !declaredIds.has(entry.identity));
    const toUndo = options.undo ? undeclared : [];
    const next: EditorHistory = { version: 1, entries: options.undo ? [] : [...undeclared], createdFiles: [...history.createdFiles] };
    const kept = new Map<string, HistoryEntry>();
    const files: EditedFile[] = [];
    const assertions: AssertionOutcome[] = [];
    const directories = { created: [] as string[], removed: [] as string[] };
    const now = (env.now ?? (() => new Date()))().toISOString();
    let ok = true;
    let applied = 0;
    let undone = 0;
    let tokenCount: { text: string; count: number } | undefined;

    const countTokens = async (text: string): Promise<number> => {
        if (tokenCount?.text !== text) tokenCount = { text, count: await env.countTokens(text) };

        return tokenCount.count;
    };

    // 1. Folders a declared entry wants: created first, so files can go in them.
    for (const entry of declared.filter((item) => item.file === undefined)) {
        const previous = previousById.get(entry.identity);

        if (previous !== undefined && entry.settings.once) {
            kept.set(entry.identity, previous);
            continue;
        }

        const steps: HistoryStep[] = entry.steps.map((step, index) => {
            const dirs = (step.params.paths as string[]).map((dir) => path.resolve(root, dir));
            const created = createDirectories(dirs, dryRun);
            const before = previous?.steps[index]?.record;
            const earlier = isJsonObject(before) && Array.isArray(before.created) ? (before.created as string[]) : [];

            for (const dir of created) {
                reporter.debug(`${dryRun ? "Would create" : "Created"} the folder ${display(dir, root)} (declared by ${entry.declarer}).`);
            }

            directories.created.push(...created);

            return { op: step.definition.name, params: step.params, record: { created: [...new Set([...earlier, ...created.map((dir) => toStored(dir, root))])] } };
        });

        kept.set(entry.identity, {
            identity: entry.identity,
            declarer: entry.declarer,
            file: "",
            rollback: entry.settings.rollback,
            backupOnRemoval: entry.settings.backupOnRemoval,
            steps,
            appliedAt: previous?.appliedAt ?? now,
        });

        if (previous === undefined) applied += 1;

        for (const step of entry.steps) {
            for (const dir of step.params.paths as string[]) {
                assertions.push({
                    file: dir,
                    path: "",
                    check: "directoryExists",
                    declarer: entry.declarer,
                    level: "warn",
                    automatic: true,
                    passed: dryRun || isDirectory(path.resolve(root, dir)),
                });
            }
        }
    }

    // 2. Files, one at a time.
    const fileNames = [
        ...new Set([
            ...declared.filter((entry) => entry.file !== undefined).map((entry) => entry.file!),
            ...toUndo.filter((entry) => entry.file !== "").map((entry) => entry.file),
        ]),
    ];

    for (const file of fileNames) {
        const here = declared.filter((entry) => entry.file === file);
        const editing = here.filter((entry) => entry.steps.length > 0);
        const undoing = toUndo.filter((entry) => entry.file === file);
        const original = readText(file);
        const session = new FileSession(file, formatForFile(file), original);
        const shown = display(file, root);
        const needsDoc =
            editing.some((entry) => entry.steps.some(needsDocument)) || undoing.some((entry) => entry.rollback && entry.steps.some(needsDocument));
        let unparseable: string | undefined;

        if (original !== undefined && needsDoc && !session.parses()) {
            try {
                session.document();
            } catch (error) {
                unparseable = error instanceof Error ? error.message : String(error);
            }

            reporter.warning(`${unparseable} None of the edits declared for it were made.`);
        }

        const events: ValueEvent[] = [];
        const fileEntries: HistoryEntry[] = [];

        if (unparseable === undefined) {
            // Undo, last applied first.
            for (const entry of [...undoing].reverse()) {
                if (!entry.rollback) {
                    reporter.debug(`Left the edits of ${entry.declarer} in ${shown} in place: it is no longer declared, and its rollback is off.`);
                    continue;
                }

                for (const step of [...entry.steps].reverse()) {
                    const definition = lookup(step.op);

                    if (definition === undefined) continue;

                    try {
                        definition.down(contextFor(session, { path: stepPath(step) }), step.params, step.record);
                        reporter.debug(`Undid ${step.op} at ${stepPath(step) || "the root"} in ${shown} (declared by ${entry.declarer}, no longer declared).`);
                    } catch (error) {
                        reporter.warning(`Could not undo ${step.op} in ${shown}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }

                undone += 1;
            }

            // Apply, in config order.
            for (const entry of editing) {
                const previous = previousById.get(entry.identity);

                if (previous !== undefined && entry.settings.once) {
                    fileEntries.push(previous);
                    continue;
                }

                const steps: HistoryStep[] = [];

                entry.steps.forEach((step, index) => {
                    const before = previous?.steps[index];

                    if (before !== undefined && step.definition.action) {
                        steps.push(before);

                        return;
                    }

                    let record: JsonValue = before?.record ?? null;

                    try {
                        record = runUp(step, contextFor(session, step), before);
                        reporter.debug(`Applied ${step.written} at ${step.path || "the root"} in ${shown} (declared by ${entry.declarer}).`);
                    } catch (error) {
                        if (!(error instanceof EditNotPossible) && !(error instanceof UnparseableFileError)) throw error;

                        reporter.warning(`${shown}: ${error.message} Declared by ${entry.declarer}; the edit was skipped.`);
                    }

                    steps.push({ op: step.definition.name, params: step.params, record });
                    events.push({ path: step.path, declarer: entry.declarer, operation: step.written, value: mainValue(step) });
                });

                if (previous === undefined) applied += 1;

                fileEntries.push({
                    identity: entry.identity,
                    declarer: entry.declarer,
                    file,
                    rollback: entry.settings.rollback,
                    backupOnRemoval: entry.settings.backupOnRemoval,
                    steps,
                    appliedAt: previous?.appliedAt ?? now,
                });
            }
        }

        // A file Sous created goes when nothing declares it any more.
        const backups: string[] = [];
        let removing = false;

        if (
            unparseable === undefined &&
            editing.length === 0 &&
            undoing.length > 0 &&
            undoing.every((entry) => entry.rollback) &&
            history.createdFiles.includes(file) &&
            session.exists()
        ) {
            removing = true;

            if (original !== undefined && undoing.some((entry) => entry.backupOnRemoval)) {
                backups.push(dryRun ? "(a backup)" : env.backup(file));
            }

            session.remove();
        }

        // Assertions.
        const authored = here.flatMap((entry) =>
            entry.asserts.map<PendingAssertion>((assertion) => ({ ...assertion, declarer: entry.declarer, automatic: false })),
        );
        const authoredAt = new Set(authored.map((assertion) => `${assertion.declarer}\0${assertion.path}`));
        const pending: PendingAssertion[] = [...authored];

        for (const entry of editing) {
            if (entry.settings.once) continue;

            const silences = here.filter((other) => other.declarer === entry.declarer).flatMap((other) => other.silences);

            for (const step of entry.steps) {
                if (!step.assertion || authoredAt.has(`${entry.declarer}\0${step.path}`)) continue;

                for (const implied of step.definition.assertions(step.params, step.path)) {
                    if (authoredAt.has(`${entry.declarer}\0${implied.path}`)) continue;

                    if (silences.some((silence) => silenceCovers(silence, implied.path, implied.check))) {
                        assertions.push({
                            file: shown,
                            path: implied.path,
                            check: implied.check,
                            declarer: entry.declarer,
                            level: "warn",
                            automatic: true,
                            passed: true,
                            silenced: true,
                        });
                        continue;
                    }

                    pending.push({
                        path: implied.path,
                        check: implied.check,
                        arg: implied.arg,
                        not: implied.not === true,
                        declarer: entry.declarer,
                        level: "warn",
                        message: undefined,
                        automatic: true,
                    });
                }
            }
        }

        const finalText = session.final();
        const subject: CheckSubject = {
            file,
            fileExists: () => session.final() !== undefined,
            directoryExists: () => isDirectory(file),
            parsed: () => unparseable === undefined && session.final() !== undefined && session.parses(),
            value: (at) => getAtPath(session.document().value(), parsePath(at)),
            text: () => session.text(),
            tokens: () => countTokens(session.text()),
        };
        let blocked = false;

        for (const assertion of pending) {
            const missingAndFine = finalText === undefined && assertion.automatic && (NEGATIVE_CHECKS.has(assertion.check) || assertion.not || assertion.arg === false);
            const passed = missingAndFine || (await runCheck(subject, assertion.check, assertion.arg, assertion.path, assertion.not));
            let report: string | undefined;

            if (!passed) {
                report = failureReport(shown, assertion, events, finalText === undefined ? "missing" : unparseable !== undefined ? "unparseable" : undefined);

                if (assertion.level === "error" && !options.ignoreFailedAssertions) {
                    reporter.error(report);
                    blocked = true;
                    ok = false;
                } else {
                    reporter.warning(report);
                }
            }

            assertions.push({
                file: shown,
                path: assertion.path,
                check: assertion.check,
                declarer: assertion.declarer,
                level: assertion.level,
                automatic: assertion.automatic,
                passed,
                ...(report === undefined ? {} : { report }),
            });
        }

        // Writing.
        if (unparseable !== undefined) {
            files.push({ file: shown, action: "skipped", reason: unparseable });
            // Nothing changed, so the history of this file stays as it was.
            for (const entry of [...undoing, ...editing.map((item) => previousById.get(item.identity)).filter((item) => item !== undefined)]) {
                kept.set(entry.identity, entry);
            }

            continue;
        }

        if (blocked) {
            files.push({ file: shown, action: "not-written", reason: "an assertion at level error failed" });

            for (const entry of [...undoing, ...editing.map((item) => previousById.get(item.identity)).filter((item) => item !== undefined)]) {
                kept.set(entry.identity, entry);
            }

            continue;
        }

        for (const entry of fileEntries) kept.set(entry.identity, entry);

        if (!session.changed()) {
            if (editing.length > 0 || undoing.length > 0) files.push({ file: shown, action: "unchanged" });

            continue;
        }

        const action: EditedFile["action"] = finalText === undefined ? "removed" : original === undefined ? "created" : "updated";

        if (action === "updated" && editing.some((entry) => entry.settings.backupBeforeChange)) {
            backups.push(dryRun ? "(a backup)" : env.backup(file));
        }

        if (!dryRun) {
            if (finalText === undefined) {
                fs.rmSync(file, { force: true });
            } else {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, finalText, "utf8");
            }
        }

        if (action === "created" && !next.createdFiles.includes(file)) next.createdFiles.push(file);
        if (removing || action === "removed") next.createdFiles = next.createdFiles.filter((created) => created !== file);

        reporter.debug(`${dryRun ? "Would have " : ""}${action} ${shown}${backups.length > 0 ? ` (backed up to ${backups.join(", ")})` : ""}.`);
        files.push({ file: shown, action, ...(backups.length > 0 ? { backups } : {}) });
    }

    // 3. Folders no entry wants any more: removed last, deepest first, only if empty.
    const folderEntries = toUndo.filter((entry) => entry.file === "");
    const candidates: string[] = [];

    for (const entry of folderEntries) {
        if (!entry.rollback) continue;

        for (const step of entry.steps) {
            const record = step.record;

            if (isJsonObject(record) && Array.isArray(record.created)) {
                candidates.push(...(record.created as string[]).map((dir) => fromStored(dir, root)));
            }
        }

        undone += 1;
    }

    // A folder another declared entry still wants stays.
    const wanted = new Set(
        declared
            .filter((entry) => entry.file === undefined)
            .flatMap((entry) => entry.steps.flatMap((step) => (step.params.paths as string[]).map((dir) => path.resolve(root, dir)))),
    );
    const removable = candidates.filter((dir) => ![...wanted].some((want) => want === dir || want.startsWith(dir + path.sep)));

    directories.removed = removeEmptyDirectories(removable, dryRun);

    for (const dir of directories.removed) {
        reporter.debug(`${dryRun ? "Would remove" : "Removed"} the empty folder ${display(dir, root)}, which Sous created and nothing declares any more.`);
    }

    // 4. The history keeps every entry applied, in the order they were declared.
    for (const entry of declared) {
        const record = kept.get(entry.identity);

        if (record !== undefined && entry.steps.length > 0) next.entries.push(record);
    }

    if (options.undo) {
        // Entries no longer declared stay only when their file was skipped or not written, to be undone later.
        next.entries.push(...undeclared.filter((entry) => kept.has(entry.identity)));
    }

    // A created file is remembered only while an entry in the history names it.
    const stillNamed = new Set(next.entries.map((entry) => entry.file));

    next.createdFiles = next.createdFiles.filter((file) => stillNamed.has(file));

    if (!dryRun) writeHistory(env.historyFile, root, next);

    return { ok, dryRun, files, directories, assertions, applied, undone };
}

/** The failure, with the history of the value (spec 08, "What a failure shows"). */
export function failureReport(
    file: string,
    assertion: Pick<PendingAssertion, "path" | "check" | "arg" | "not" | "declarer" | "message" | "automatic">,
    events: readonly ValueEvent[],
    state: "missing" | "unparseable" | undefined,
): string {
    const where = assertion.path === "" ? `Assertion failed in ${file}` : `Assertion failed in ${file} at ${assertion.path}`;
    const lines = [where, `  ${assertion.declarer} expects ${assertion.path === "" ? "the file" : "it"} to ${describeCheck(assertion.check, assertion.arg, assertion.not)}.`];

    if (assertion.message !== undefined) lines.push(`  ${assertion.message}`);
    if (assertion.automatic) lines.push("  (An automatic assertion: the edit's result did not hold after every edit to the file.)");
    if (state === "missing") lines.push("  The file does not exist.");
    if (state === "unparseable") lines.push("  Sous could not parse the file, so none of its edits were made.");

    const target = parsePath(assertion.path);
    const touching = events.filter((event) => pathsOverlap(parsePath(event.path), target));

    if (touching.length > 0) {
        const width = Math.max(...touching.map((event) => event.declarer.length));
        const opWidth = Math.max(...touching.map((event) => event.operation.length));

        lines.push("", "  What changed this value, in order:");
        touching.forEach((event, index) => {
            lines.push(`    ${index + 1}. ${event.declarer.padEnd(width)}   ${event.operation.padEnd(opWidth)}   ${event.value}`.trimEnd());
        });
    } else if (state === undefined) {
        lines.push("", "  No edit Sous made in this build changed this value.");
    }

    return lines.join("\n");
}
