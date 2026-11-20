/**
 * The contract of `@sous-io/sous-plugin-editor`: the `editor.edits` config key (the master list of
 * edits to files Sous does not own), the `editor` service for direct usage, the internal
 * `editor.apply` intent, and the history it keeps.
 *
 * Other plugins import this file type-only.
 */

import type { JsonObject, JsonValue } from "@sous-io/sous-plugin-api";
import type { EditableDocument, EditorFormat } from "./documents-adapter.js";

export type { EditableDocument, EditorFormat } from "./documents-adapter.js";

// ---------------------------------------------------------------------------------------------
// The `editor.edits` config key
// ---------------------------------------------------------------------------------------------

/**
 * Where an operation puts what it adds. For a list, `first` and `last` (or `start` and `end`) and
 * a number (an index from 0); for lines, also `{ after: "..." }`, `{ before: "..." }` and
 * `{ line: 3 }` (a line number from 1). An `after` or `before` that is not found puts it at the end.
 */
export type EditPosition =
    | "first"
    | "last"
    | "start"
    | "end"
    | number
    | { after: JsonValue }
    | { before: JsonValue }
    | { line: number };

/** The settings every operation's object may carry besides its own parameters. */
export interface OperationCommon {
    /** Where in the file the operation acts. Left out, or `""`, is the root. */
    path?: string;
    /** `"none"` drops the automatic assertion that goes with this operation. */
    assertion?: "none";
    /** In a YAML file holding several documents (`---` between them), the one to act on, from 0 (spec 07, `selectDocument`). */
    document?: number;
}

/** One operation, as written in an entry: its name and its object. */
export type OperationCall = Record<string, JsonObject>;

/** How an automatic assertion is silenced at a path (spec 08, "Silencing Automatic Assertions"). */
export interface SilenceSettings {
    /** The path; left out is the whole file. */
    path?: string;
    /** The kinds to silence (`sorted`, `unique`, `includes`, ...). Left out: every kind. */
    kinds?: string | string[];
    /** Every kind except these. Only without `kinds`. */
    except?: string | string[];
    /** `key-and-below` (the default), `key-only`, or `below`. */
    scope?: "key-and-below" | "key-only" | "below";
}

/** An assertion an author wrote: a path, one or more checks, a level and a message. */
export interface AssertSettings {
    path?: string;
    /** `error` (the default) fails the build; `warn` prints a warning. */
    level?: "error" | "warn";
    /** What to tell the person whose build failed. */
    message?: string;
    /** Turns every check in this object around: `includes` becomes "does not include". */
    not?: boolean;
    [check: string]: JsonValue | undefined;
}

/**
 * One entry of `editor.edits`. ONE form (spec 07, "The Shape of an Entry"): `file`, the entry's
 * settings, then one or more operation keys each holding an object with everything the
 * operation needs, or an `operations` list. There is no `id`: an entry's identity is who declared
 * it plus what it says.
 *
 * ```yaml
 * - file: .claude/settings.json
 *   set:
 *     path: env.SESSION_HARNESS_MODE
 *     value: strict
 *   ensureIncludes:
 *     path: permissions.allow
 *     items: ["Bash(git-commit.sh:*)"]
 *   sort:
 *     path: permissions.allow
 * ```
 */
export interface EditEntry {
    /** The file; relative paths are relative to the project root. Not needed by `ensureDirectoryExists`. */
    file?: string;
    /** Applies the entry on the first run only. Default `false`. */
    once?: boolean;
    /** Undoes the entry when it is no longer declared. Default `true`. */
    rollback?: boolean;
    /** Copies the file to `.sous/backups/` before Sous first changes it in a run. Default `false`. */
    backupBeforeChange?: boolean;
    /** Copies the file to `.sous/backups/` before a rollback deletes it. Default `true`. */
    backupOnRemoval?: boolean;
    /** The recipe that declared it, set by the contributor that adds a manifest's `edits`. */
    recipe?: string;
    /** Operations in an exact order, or one operation more than once. */
    operations?: OperationCall[];
    /** An assertion about the file, or a value in it. */
    assert?: AssertSettings;
    /** Silences this declarer's automatic assertions on this file. `{}` is the whole file. */
    silence?: SilenceSettings;
    /** Any operation, by name or alias, holding its object. */
    [operation: string]: unknown;
}

/** The `editor` config key. */
export interface EditorSettings {
    /** The master list of edits. Default `[]`. */
    edits: EditEntry[];
    /** Where the history is kept. Default `${sousDir}/sous.edits.json`. */
    historyFile?: string;
}

// ---------------------------------------------------------------------------------------------
// Operations and checks, as their definitions describe them
// ---------------------------------------------------------------------------------------------

/** What an operation acts on. */
export type OperationScope = "document" | "file" | "directory";

/** One operation the editor knows, as `operations()` lists it. */
export interface OperationInfo {
    readonly name: string;
    /** Where it runs among several operation keys in one entry: lower first. */
    readonly order: number;
    readonly scope: OperationScope;
    /** True for an action that acts every time it runs (`append`); Sous runs it once per declaration. */
    readonly action: boolean;
    /** Its parameters, besides `path` and `assertion`. */
    readonly params: readonly string[];
    /** The parameters the chain takes in order, before an options object. */
    readonly args: readonly string[];
    /** The other names for it, each with what it stands for. */
    readonly aliases: ReadonlyArray<{ readonly name: string; readonly means: string }>;
    readonly summary: string;
}

/** One check, as an assertion is made of. */
export interface CheckSpec {
    /** The check's key in an `assert` object: `includes`, `sorted`, `maxBytes`. */
    readonly check: string;
    /** Its argument as written. */
    readonly arg: JsonValue;
    /** The path it reads; `""` is the root. */
    readonly path: string;
    /** Turned around. */
    readonly not?: boolean;
}

/** One assertion that failed, or passed. */
export interface AssertionOutcome {
    readonly file: string;
    readonly path: string;
    readonly check: string;
    readonly declarer: string;
    readonly level: "error" | "warn";
    readonly automatic: boolean;
    readonly passed: boolean;
    /** Silenced automatic assertions are listed, never run. */
    readonly silenced?: boolean;
    /** The full message, with the history of the value, for a failure. */
    readonly report?: string;
}

// ---------------------------------------------------------------------------------------------
// The history
// ---------------------------------------------------------------------------------------------

/** One operation of an applied entry, with what `up` reported so `down` can undo it. */
export interface HistoryStep {
    readonly op: string;
    readonly params: JsonObject;
    readonly record: JsonValue;
}

/** One applied entry. */
export interface HistoryEntry {
    /** Who declared it plus what it says, hashed. */
    readonly identity: string;
    /** `voltagrid/session-harness`, `@acme/sous-plugin-x`, `project`. */
    readonly declarer: string;
    /** The file (relative to the project root when inside it), or `""` for folders. */
    readonly file: string;
    readonly rollback: boolean;
    readonly backupOnRemoval: boolean;
    readonly steps: HistoryStep[];
    readonly appliedAt: string;
}

/** The history file: every applied entry, and the files and folders Sous created. */
export interface EditorHistory {
    readonly version: 1;
    entries: HistoryEntry[];
    /** Files Sous created because they were missing, relative to the project root when inside it. */
    createdFiles: string[];
    /**
     * For each created file, the missing parent folders Sous created to hold it, top down. They are
     * removed with the file when it is rolled back, if empty and no folder entry wants them.
     */
    createdFolders: Record<string, string[]>;
}

// ---------------------------------------------------------------------------------------------
// The `editor.apply` intent
// ---------------------------------------------------------------------------------------------

/** The input of `editor.apply` (internal). */
export interface EditorApplyInput {
    /** Works everything out and reports it, writing nothing. */
    dryRun?: boolean;
    /** A failed assertion at level error is printed as a warning and the build carries on. */
    ignoreFailedAssertions?: boolean;
}

/** What happened to one file or folder. */
export interface EditedFile {
    readonly file: string;
    readonly action: "created" | "updated" | "removed" | "unchanged" | "skipped" | "not-written";
    /** Why it was skipped or not written. */
    readonly reason?: string;
    readonly backups?: string[];
}

/** The result of `editor.apply`. */
export interface EditorApplyResult {
    /** False when an assertion at level error failed and was not ignored. */
    readonly ok: boolean;
    readonly dryRun: boolean;
    readonly files: EditedFile[];
    readonly directories: { created: string[]; removed: string[] };
    readonly assertions: AssertionOutcome[];
    /** Entries applied this run, and entries undone. */
    readonly applied: number;
    readonly undone: number;
}

// ---------------------------------------------------------------------------------------------
// The `editor` service (direct usage, spec 06)
// ---------------------------------------------------------------------------------------------

/** One file opened for editing. */
export interface EditorFile {
    /** The file, absolute. */
    readonly path: string;
    readonly format: EditorFormat;
    /** Whether the file was there when it was opened. */
    readonly existed: boolean;
    /** The document, for reading (`document.atPath("a").get()`) and for edits of your own. */
    readonly document: EditableDocument;
    /**
     * Runs one operation, by name or alias, with its object, and returns what `up` reported
     * (keep it to undo the operation with {@link undo}).
     */
    apply(operation: string, params?: JsonObject): JsonValue;
    /** Undoes an operation with what {@link apply} returned. */
    undo(operation: string, params: JsonObject, record: JsonValue): void;
    /** Runs one check on the file as it is now. */
    check(check: string, arg: JsonValue, options?: { path?: string; not?: boolean }): Promise<boolean>;
    /** The text with every edit made. */
    text(): string;
    /** Whether the text differs from what was read. */
    changed(): boolean;
    /** Writes the file when it changed, creating its folder. Returns whether it wrote. */
    write(): boolean;
}

/** The editor: opens a file, applies operations, gives the changed text, writes it. */
export interface EditorService {
    /** Opens a file (`${var}` is substituted; relative paths are from the project root). A missing file opens empty. */
    open(file: string, options?: { format?: EditorFormat }): EditorFile;
    /** Opens text that is not in a file. */
    parse(text: string, format: EditorFormat): EditorFile;
    /** The format a file name means. */
    formatOf(file: string): EditorFormat;
    /** Every operation, with its order, parameters and aliases. */
    operations(): OperationInfo[];
    /** Every check an assertion can use. */
    checks(): string[];
}

declare module "@sous-io/sous-plugin-api" {
    interface SousServices {
        /** The editor: surgical edits to JSON, JSONC, YAML, Markdown frontmatter and plain text. */
        editor: EditorService;
    }

    interface SousIntents {
        /** Applies `editor.edits`, undoes what is no longer declared, and checks the assertions (internal). */
        "editor.apply": { input: EditorApplyInput; result: EditorApplyResult };
    }

    interface SousConfig {
        editor: EditorSettings;
    }
}
