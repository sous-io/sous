/**
 * The history: a JSON file in `.sous/` (git-ignored, one per project) recording every entry the
 * editor applied, who declared it, and what each operation's `up` reported so its `down` can undo
 * it; and the files and folders Sous created because they were missing. Paths inside the project
 * are written relative to its root; outside files keep their absolute path (spec 07, "Files Outside
 * the Project": each project keeps its own record, even of an outside file).
 */

import fs from "node:fs";
import path from "node:path";
import type { EditorHistory, HistoryEntry } from "./types.js";

/** The history file's name inside `.sous/`. */
export const HISTORY_FILE_NAME = "sous.edits.json";

/** An empty history. */
export function emptyHistory(): EditorHistory {
    return { version: 1, entries: [], createdFiles: [], createdFolders: {} };
}

/** A path as the history writes it: relative to the project root when inside it. */
export function toStored(file: string, root: string): string {
    if (file === "") return "";

    const relative = path.relative(root, file);

    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.split(path.sep).join("/") : file;
}

/** A stored path as an absolute one. */
export function fromStored(file: string, root: string): string {
    return file === "" ? "" : path.resolve(root, file);
}

/**
 * Reads the history, with every path made absolute. A missing or unreadable file is an empty
 * history (Sous then has nothing to undo, which is the safe side).
 */
export function readHistory(file: string, root: string): EditorHistory {
    let parsed: unknown;

    try {
        parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return emptyHistory();
    }

    const value = parsed as Partial<EditorHistory> | null;

    if (value === null || typeof value !== "object" || !Array.isArray(value.entries)) {
        return emptyHistory();
    }

    return {
        version: 1,
        entries: value.entries.map((entry: HistoryEntry) => ({ ...entry, file: fromStored(entry.file, root) })),
        createdFiles: (value.createdFiles ?? []).map((created) => fromStored(created, root)),
        // A history written before folders were recorded has none.
        createdFolders: Object.fromEntries(
            Object.entries(value.createdFolders ?? {}).map(([created, dirs]) => [fromStored(created, root), dirs.map((dir) => fromStored(dir, root))]),
        ),
    };
}

/** Writes the history, paths relative to the project root where they can be. */
export function writeHistory(file: string, root: string, history: EditorHistory): void {
    const stored: EditorHistory = {
        version: 1,
        entries: history.entries.map((entry) => ({ ...entry, file: toStored(entry.file, root) })),
        createdFiles: [...new Set(history.createdFiles.map((created) => toStored(created, root)))].sort(),
        createdFolders: Object.fromEntries(
            Object.entries(history.createdFolders)
                .map(([created, dirs]): [string, string[]] => [toStored(created, root), dirs.map((dir) => toStored(dir, root))])
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ),
    };

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
}
