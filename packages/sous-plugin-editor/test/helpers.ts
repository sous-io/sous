/**
 * Helpers for the editor's tests: a temporary directory, running one operation on text, and
 * applying a list of entries the way `editor.apply` does, without the engine.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BufferedReporter, type JsonObject, type JsonValue } from "@sous-io/sous-plugin-api";
import { applyEdits, type DeclaredEntry } from "../src/apply.js";
import type { EditorFormat } from "../src/documents-adapter.js";
import { declarerLabel, entryIdentity, normalizeEntry } from "../src/entries.js";
import { toStored } from "../src/history.js";
import { OPERATIONS, resolveOperation } from "../src/operations.js";
import { FileSession } from "../src/session.js";
import type { EditorApplyResult } from "../src/types.js";

/** A temporary directory, removed by `cleanup()`. Its path is real, so paths compare equal. */
export function makeTmpDir(prefix = "sous-editor-"): { path: string; cleanup(): void } {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

    return { path: dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Writes a file under `root`, creating its folders. */
export function write(root: string, rel: string, contents: string): string {
    const file = path.join(root, rel);

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, "utf8");

    return file;
}

/** Reads a file under `root`, or `undefined`. */
export function read(root: string, rel: string): string | undefined {
    try {
        return fs.readFileSync(path.join(root, rel), "utf8");
    } catch {
        return undefined;
    }
}

/** Runs one operation on text; returns the text, the record, and a way to undo it. */
export function run(
    text: string | undefined,
    format: EditorFormat,
    operation: string,
    params: JsonObject,
    file = "file",
): { text: string | undefined; record: JsonValue; undo(): string | undefined; session: FileSession } {
    const session = new FileSession(file, format, text);
    const step = resolveOperation(operation, params);
    const ctx = { session, path: step.path, node: () => session.document().atPath(step.path) };
    const record = step.definition.up(ctx, step.params, undefined);

    return {
        text: session.final(),
        record,
        session,
        undo() {
            step.definition.down(ctx, step.params, record);

            return session.final();
        },
    };
}

/** One declared entry: as written, and who declared it. */
export interface TestEntry {
    entry: JsonObject;
    by?: string;
}

/** Entries as `editor.apply` would see them. */
export function declare(root: string, entries: readonly TestEntry[]): DeclaredEntry[] {
    return entries.map(({ entry, by }) => {
        const normalized = normalizeEntry(entry);
        const declarer = declarerLabel({ plugin: by ?? "project-plugin", contributor: "test" }, normalized.recipe);
        const file = normalized.file === undefined ? undefined : path.resolve(root, normalized.file);

        return {
            identity: entryIdentity(declarer, file === undefined ? "" : toStored(file, root), normalized.steps),
            declarer,
            file,
            settings: normalized.settings,
            steps: normalized.steps,
            asserts: normalized.asserts,
            silences: normalized.silences,
        };
    });
}

/** Applies entries in a project root, as `editor.apply` does. */
export async function apply(
    root: string,
    entries: readonly TestEntry[],
    options: { dryRun?: boolean; ignoreFailedAssertions?: boolean; undo?: boolean } = {},
): Promise<{ result: EditorApplyResult; reporter: BufferedReporter }> {
    const reporter = new BufferedReporter();
    let backups = 0;
    const result = await applyEdits(
        declare(root, entries),
        {
            projectRoot: root,
            historyFile: path.join(root, ".sous", "sous.edits.json"),
            reporter,
            backup(file) {
                backups += 1;

                const target = path.join(root, ".sous", "backups", `run-${backups}`, path.relative(root, file));

                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.copyFileSync(file, target);

                return target;
            },
            countTokens: async (text) => text.split(/\s+/).filter(Boolean).length,
            now: () => new Date("2026-11-18T00:00:00Z"),
        },
        { dryRun: options.dryRun, ignoreFailedAssertions: options.ignoreFailedAssertions, undo: options.undo ?? true },
        (op) => OPERATIONS.get(op),
    );

    return { result, reporter };
}
