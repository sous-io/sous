/**
 * The chain style for plugins (spec 07, "Style 2: method chaining") and `expect` (spec 08, "In a
 * plugin: the `expect` style").
 *
 * THE CHAIN RECORDS; IT DOES NOT RUN. Each call appends one entry to `editor.edits`, the same entry
 * the object style or a recipe's manifest would write. Nothing is read or written until the
 * editor applies the list after the config is built, so the chain has no `get` or `exists`, and a
 * property such as `file.byteCount` is a reference to "the byte count of that file", never a
 * number.
 *
 * ```ts
 * contribute(config) {
 *     const settings = editor(config).file("${projectRoot}/.claude/settings.json");
 *
 *     settings.at("env.ACME_COMMS_DIR").set("${projectRoot}/comms");
 *     settings.at("permissions.allow").appendIfMissing("Bash(acme-commit.sh:*)").dedupe().sort();
 *
 *     expect( settings.at("permissions.allow") ).to.include("Bash(acme-commit.sh:*)");
 *     expect( settings.byteCount ).to.be.lessThan(100000).orWarn();
 * }
 * ```
 */

import { deepEqual, type JsonObject, type JsonValue } from "@sous-io/sous-lib-documents";
import type { ConfigBuilder, DocumentNode } from "@sous-io/sous-plugin-api";
import { ALIASES, chainParams, OPERATIONS } from "./operations.js";
import { EDITS_KEY } from "./entries.js";
import type { EditPosition } from "./types.js";

/** The settings of every entry a file handle records (spec 12). */
export interface FileSettings {
    once?: boolean;
    rollback?: boolean;
    backupBeforeChange?: boolean;
    backupOnRemoval?: boolean;
}

/** Appends entries to `editor.edits`, and changes one already appended. */
class Recorder {
    private readonly edits: DocumentNode;

    constructor(config: ConfigBuilder) {
        this.edits = config.atPath(EDITS_KEY);
    }

    /** Appends an entry; returns the copy kept to find it again. */
    append(entry: JsonObject): JsonObject {
        this.edits.appendValue(entry);

        return structuredClone(entry);
    }

    /** Changes an entry this recorder appended: finds it (the last equal one) and replaces it. */
    update(entry: JsonObject, change: (entry: JsonObject) => void): void {
        const items = this.edits.get<JsonValue[]>() ?? [];
        let index = -1;

        for (let at = items.length - 1; at >= 0; at--) {
            if (deepEqual(items[at], entry)) {
                index = at;
                break;
            }
        }

        change(entry);

        if (index !== -1) {
            this.edits.atIndex(index).set(entry);
        }
    }
}

/** The operation methods a value handle has, one per operation, alias and shorthand. */
export interface ValueOperations<R> {
    // Any value
    set(value: unknown, options?: { ifMissing?: boolean }): R;
    ensureValue(value: unknown): R;
    replace(value: unknown): R;
    setIfMissing(value: unknown): R;
    ensureDefault(value: unknown): R;
    setIfEquals(value: unknown, equals: unknown): R;
    delete(): R;
    ensureAbsent(): R;
    deleteIfEquals(value: unknown): R;
    deleteIfEmpty(): R;
    // Objects
    merge(value: object, options?: { ifMissing?: boolean }): R;
    ensureKeys(value: object): R;
    deepMerge(value: object): R;
    mergeIfMissing(value: object): R;
    renameKey(name: string): R;
    deleteKeys(keys: string | string[]): R;
    keepOnlyKeys(keys: string | string[]): R;
    sortKeys(): R;
    moveKeyBefore(key: string, anchor: string): R;
    moveKeyAfter(key: string, anchor: string): R;
    moveKeyFirst(key: string): R;
    moveKeyLast(key: string): R;
    // Structure
    ensureObject(): R;
    ensureList(): R;
    wrapInList(): R;
    unwrapList(): R;
    // Lists
    ensureIncludes(items: unknown, options?: { position?: EditPosition }): R;
    appendIfMissing(items: unknown): R;
    prependIfMissing(items: unknown): R;
    union(items: unknown[]): R;
    ensureFirst(item: unknown): R;
    ensureLast(item: unknown): R;
    ensureAt(index: number, item: unknown): R;
    append(item: unknown, options?: { position?: EditPosition }): R;
    prepend(item: unknown): R;
    insertAt(index: number, item: unknown): R;
    insertBefore(before: unknown, item: unknown): R;
    insertAfter(after: unknown, item: unknown): R;
    upsertWhere(match: object, item: unknown): R;
    ensureItemWhere(match: object, item: unknown): R;
    remove(options: { values?: unknown[]; where?: object }): R;
    removeValues(values: unknown[]): R;
    ensureExcludes(values: unknown[]): R;
    removeValue(value: unknown): R;
    removeWhere(where: object): R;
    ensureNoItemWhere(where: object): R;
    removeAt(index: number): R;
    replaceWhere(where: object, item: unknown): R;
    updateWhere(where: object, value: object): R;
    mergeWhere(where: object, value: object): R;
    dedupe(options?: { by?: string }): R;
    ensureUnique(options?: { by?: string }): R;
    dedupeBy(by: string): R;
    sort(options?: { by?: string; descending?: boolean }): R;
    ensureSorted(options?: { by?: string; descending?: boolean }): R;
    sortBy(by: string, options?: { descending?: boolean }): R;
    // Text
    ensureLine(line: string, options?: { position?: EditPosition }): R;
    removeLine(line: string): R;
    ensureBlock(name: string, content: string, options?: { position?: EditPosition; comment?: string | { start: string; end?: string } }): R;
    appendText(value: string): R;
    prependText(value: string): R;
    replaceText(match: string, value: string): R;
    replacePattern(match: string, value: string): R;
    // Numbers and booleans
    increment(value?: number): R;
    decrement(value?: number): R;
    toggle(): R;
    // Comments
    setCommentBefore(text: string): R;
    setCommentAfter(text: string): R;
}

/** One value inside a file: every operation, recorded at its path. */
export interface ValueHandle extends ValueOperations<ValueHandle> {
    /** The file. */
    readonly file: string;
    /** The path; `""` is the root. */
    readonly path: string;
    /** Drops the automatic assertion of the operation recorded last. */
    withoutAssertion(): ValueHandle;
}

/** A reference to a size of a file, for `expect`. It is NOT a number: the file is read later. */
export interface SizeReference {
    readonly kind: "size";
    readonly file: string;
    readonly measure: "bytes" | "characters" | "tokens";
}

/** Narrows a silence to one scope, or turns it into "every kind except". */
export interface SilenceHandle {
    /** This exact key only. */
    thisKeyOnly(): SilenceHandle;
    /** Only what is below this key. */
    belowOnly(): SilenceHandle;
    /** Every kind except these. Only after a `silence` with no kinds. */
    except(kinds: string | string[]): SilenceHandle;
}

/** One file: a value handle at its root, plus what belongs to the file itself. */
export interface FileHandle extends ValueOperations<ValueHandle> {
    readonly file: string;
    readonly path: "";
    /** A value inside the file. */
    at(path: string): ValueHandle;
    /** The file exists; a missing one is created with `content`. */
    ensureFileExists(content?: unknown): FileHandle;
    /** Silences this plugin's automatic assertions at a path (this key and below), every kind or the ones named. */
    silence(path?: string, kinds?: string | string[]): SilenceHandle;
    /** Silences every automatic assertion of this plugin's edits to this file. */
    withoutAutomaticAssertions(): FileHandle;
    /** The file's size in bytes: a reference for `expect`, not a number. */
    readonly byteCount: SizeReference;
    /** The file's size in characters: a reference for `expect`, not a number. */
    readonly characterCount: SizeReference;
    /** The file's size in tokens (`o200k_base`, approximate for any one model): a reference for `expect`, not a number. */
    readonly tokenCount: SizeReference;
}

/** The entry point: `editor(config).file(path)`. */
export interface EditorChain {
    /** A handle on one file. Nothing is read or written here. */
    file(path: string, settings?: FileSettings): FileHandle;
    /** The folders exist (`ensureDirectoryExists`). */
    ensureDirectoryExists(paths: string | string[], settings?: FileSettings): void;
}

/** The names a value handle has a method for: every document operation, alias and shorthand. */
export const CHAIN_OPERATION_NAMES: readonly string[] = [
    ...[...OPERATIONS.values()].filter((definition) => definition.scope === "document").map((definition) => definition.name),
    ...[...ALIASES.values()].filter((entry) => OPERATIONS.get(entry.target)?.scope === "document").map((entry) => entry.name),
];

class ValueHandleImpl {
    protected last: JsonObject | undefined;
    protected lastOperation: string | undefined;

    constructor(
        protected readonly recorder: Recorder,
        readonly file: string,
        readonly path: string,
        protected readonly settings: FileSettings,
    ) {}

    /** Records one operation as an entry of its own. */
    record(operation: string, args: readonly unknown[]): ValueHandleImpl {
        const params = chainParams(operation, args);
        const object: JsonObject = this.path === "" ? params : { path: this.path, ...params };
        const entry: JsonObject = { file: this.file, ...(this.settings as JsonObject), [operation]: object };

        this.last = this.recorder.append(entry);
        this.lastOperation = operation;

        return this;
    }

    withoutAssertion(): ValueHandleImpl {
        if (this.last === undefined || this.lastOperation === undefined) {
            throw new Error("withoutAssertion() follows an operation: settings.at(\"a\").sort().withoutAssertion().");
        }

        const operation = this.lastOperation;

        this.recorder.update(this.last, (entry) => {
            (entry[operation] as JsonObject).assertion = "none";
        });

        return this;
    }
}

for (const name of CHAIN_OPERATION_NAMES) {
    Object.defineProperty(ValueHandleImpl.prototype, name, {
        value(this: ValueHandleImpl, ...args: unknown[]) {
            return this.record(name, args);
        },
        writable: true,
        configurable: true,
    });
}

class SilenceHandleImpl implements SilenceHandle {
    constructor(
        private readonly recorder: Recorder,
        private readonly entry: JsonObject,
        private readonly hasKinds: boolean,
    ) {}

    private change(key: string, value: JsonValue): SilenceHandle {
        this.recorder.update(this.entry, (entry) => {
            (entry.silence as JsonObject)[key] = value;
        });

        return this;
    }

    thisKeyOnly(): SilenceHandle {
        return this.change("scope", "key-only");
    }

    belowOnly(): SilenceHandle {
        return this.change("scope", "below");
    }

    except(kinds: string | string[]): SilenceHandle {
        if (this.hasKinds) {
            throw new Error("except() only follows a silence with no kinds: settings.silence(\"permissions.allow\").except([\"include\"]).");
        }

        return this.change("except", [kinds].flat());
    }
}

class FileHandleImpl extends ValueHandleImpl {
    constructor(recorder: Recorder, file: string, settings: FileSettings) {
        super(recorder, file, "", settings);
    }

    at(path: string): ValueHandle {
        return new ValueHandleImpl(this.recorder, this.file, path, this.settings) as unknown as ValueHandle;
    }

    /** Records on a fresh handle at the root, so `file.sort()` and `file.at("").sort()` are the same. */
    override record(operation: string, args: readonly unknown[]): ValueHandleImpl {
        return new ValueHandleImpl(this.recorder, this.file, "", this.settings).record(operation, args);
    }

    ensureFileExists(content?: unknown): FileHandle {
        const object: JsonObject = content === undefined ? {} : { content: content as JsonValue };

        this.recorder.append({ file: this.file, ...(this.settings as JsonObject), ensureFileExists: object });

        return this as unknown as FileHandle;
    }

    silence(path = "", kinds?: string | string[]): SilenceHandle {
        const silence: JsonObject = {
            ...(path === "" ? {} : { path }),
            ...(kinds === undefined ? {} : { kinds: [kinds].flat() }),
        };
        const entry = this.recorder.append({ file: this.file, silence });

        return new SilenceHandleImpl(this.recorder, entry, kinds !== undefined);
    }

    withoutAutomaticAssertions(): FileHandle {
        this.recorder.append({ file: this.file, silence: {} });

        return this as unknown as FileHandle;
    }

    // byteCount, characterCount and tokenCount are defined below, beside `expect`.
}

/** The recorder of each config builder, so every handle of one contributor run shares one. */
const recorders = new WeakMap<ConfigBuilder, Recorder>();

function recorderFor(config: ConfigBuilder): Recorder {
    let recorder = recorders.get(config);

    if (recorder === undefined) {
        recorder = new Recorder(config);
        recorders.set(config, recorder);
    }

    return recorder;
}

/**
 * The chain's entry point. `editor(config)` ties every handle to the config being built, where
 * the edits and assertions are recorded.
 *
 * ```ts
 * const settings = editor(config).file("${projectRoot}/.claude/settings.json");
 *
 * settings.at("permissions.allow").ensureIncludes("Bash(acme-commit.sh:*)");
 * ```
 */
export function editor(config: ConfigBuilder): EditorChain {
    const recorder = recorderFor(config);

    return {
        file(path, settings = {}) {
            return new FileHandleImpl(recorder, path, settings) as unknown as FileHandle;
        },
        ensureDirectoryExists(paths, settings = {}) {
            recorder.append({ ...(settings as JsonObject), ensureDirectoryExists: { paths: [paths].flat() } });
        },
    };
}

// ---------------------------------------------------------------------------------------------
// expect
// ---------------------------------------------------------------------------------------------

/** What `expect` takes: a value in a file, a file, or a size of a file. */
export type ExpectSubject = ValueHandle | FileHandle | SizeReference;

function isSize(subject: ExpectSubject): subject is SizeReference {
    return (subject as SizeReference).kind === "size";
}

function isFileHandle(subject: ExpectSubject): boolean {
    return subject instanceof FileHandleImpl;
}

function recorderOf(subject: ExpectSubject): Recorder {
    const handle = subject as unknown as { recorder?: Recorder; owner?: Recorder };

    return (handle.recorder ?? handle.owner)!;
}

/** The size checks for each measure, as `[max, min]`. */
const SIZE_CHECKS = {
    bytes: ["maxBytes", "minBytes"],
    characters: ["maxCharacters", "minCharacters"],
    tokens: ["maxTokens", "minTokens"],
} as const;

/**
 * One `expect(...)`: linking words, then a check that ends in a method call, then `.orWarn()` and
 * `.withMessage(...)`. Every check is recorded as an `assert` entry in `editor.edits`.
 */
export class Expectation {
    private negate = false;
    private flag: "unique" | "first" | "last" | undefined;
    private readonly recorded: JsonObject[] = [];

    constructor(
        private readonly subject: ExpectSubject,
        private readonly recorder: Recorder,
    ) {}

    // Linking words: they read as English and change nothing.
    get to(): this { return this; }
    get be(): this { return this; }
    get been(): this { return this; }
    get is(): this { return this; }
    get that(): this { return this; }
    get which(): this { return this; }
    get and(): this { return this; }
    get has(): this { return this; }
    get have(): this { return this; }
    get with(): this { return this; }
    get at(): this { return this; }
    get of(): this { return this; }
    get does(): this { return this; }

    /** Turns the next check around. */
    get not(): this {
        this.negate = !this.negate;

        return this;
    }

    /** For `.to.have.unique.members()`. */
    get unique(): this {
        this.flag = "unique";

        return this;
    }

    /** For `.to.have.first.member(x)`. */
    get first(): this {
        this.flag = "first";

        return this;
    }

    /** For `.to.have.last.member(x)`. */
    get last(): this {
        this.flag = "last";

        return this;
    }

    private record(check: string, arg: JsonValue): this {
        const subject = this.subject;
        const file = subject.file;
        const path = isSize(subject) ? "" : (subject as ValueHandle).path;
        const assert: JsonObject = { ...(path === "" ? {} : { path }), [check]: arg, ...(this.negate ? { not: true } : {}) };

        this.recorded.push(this.recorder.append({ file, assert }));
        this.flag = undefined;

        return this;
    }

    private needsValue(name: string): void {
        if (isSize(this.subject)) {
            throw new Error(`${name}() checks a value in a file; a size is checked with lessThan, lessThanOrEqualTo, greaterThan or greaterThanOrEqualTo.`);
        }
    }

    /** The value includes this item (a list), these keys (an object) or this text (a string). */
    include(value: unknown): this {
        this.needsValue("include");

        return this.record("includes", value as JsonValue);
    }

    /** The same as {@link include}. */
    contain(value: unknown): this {
        return this.include(value);
    }

    /** The value equals this, deeply. */
    equal(value: unknown): this {
        this.needsValue("equal");

        return this.record("equals", value as JsonValue);
    }

    /** The same as {@link equal}. */
    eql(value: unknown): this {
        return this.equal(value);
    }

    /** The value exists; for a file, the file exists. `.to.not.exist()` for the opposite. */
    exist(): this {
        this.needsValue("exist");

        if (isFileHandle(this.subject)) {
            const negate = this.negate;

            this.negate = false;

            return this.record(negate ? "fileDoesNotExist" : "fileExists", true);
        }

        return this.record("exists", true);
    }

    /** The value is of this type: `array`, `object`, `string`, `number`, `boolean`, `null`. */
    a(type: string): this {
        this.needsValue("a");

        return this.record("type", type);
    }

    /** The same as {@link a}. */
    an(type: string): this {
        return this.a(type);
    }

    /** The list is sorted; `by` sorts by one field. */
    sorted(options: { by?: string; descending?: boolean } = {}): this {
        this.needsValue("sorted");

        return this.record("sorted", Object.keys(options).length === 0 ? true : (options as JsonObject));
    }

    /** `.to.have.unique.members()`: no item is there twice. */
    members(): this {
        this.needsValue("members");

        if (this.flag !== "unique") {
            throw new Error("members() follows unique: expect(x).to.have.unique.members().");
        }

        return this.record("unique", true);
    }

    /** `.to.have.first.member(x)` or `.to.have.last.member(x)`; without either, the list includes it. */
    member(value: unknown): this {
        this.needsValue("member");

        if (this.flag === "first") return this.record("first", value as JsonValue);
        if (this.flag === "last") return this.record("last", value as JsonValue);

        return this.record("includes", value as JsonValue);
    }

    /** The text matches a regular expression. */
    match(pattern: RegExp | string): this {
        this.needsValue("match");

        return this.record("matches", typeof pattern === "string" ? pattern : `/${pattern.source}/${pattern.flags}`);
    }

    /** The list has an item with these fields (equal to `item`, when given). */
    itemWhere(match: object, item?: unknown): this {
        this.needsValue("itemWhere");

        if (this.negate) {
            this.negate = false;

            return this.record("noItemWhere", match as JsonObject);
        }

        return this.record("itemWhere", item === undefined ? (match as JsonObject) : { match: match as JsonObject, item: item as JsonValue });
    }

    /** The text contains this line. */
    line(line: string): this {
        this.needsValue("line");

        return this.record("includesLine", line);
    }

    /** The object's keys are in order. */
    sortedKeys(): this {
        this.needsValue("sortedKeys");

        return this.record("sortedKeys", true);
    }

    private compare(kind: "lt" | "lte" | "gt" | "gte", value: number): this {
        const subject = this.subject;

        if (isSize(subject)) {
            if (this.negate) {
                throw new Error("A size check cannot be turned around with not; use the opposite comparison.");
            }

            const [max, min] = SIZE_CHECKS[subject.measure];

            // A size is a whole number, so "less than 32768" is "at most 32767".
            switch (kind) {
                case "lt":
                    return this.record(max, Math.ceil(value) - 1);
                case "lte":
                    return this.record(max, Math.floor(value));
                case "gt":
                    return this.record(min, Math.floor(value) + 1);
                case "gte":
                    return this.record(min, Math.ceil(value));
            }
        }

        const check = { lt: "lessThan", lte: "lessThanOrEqualTo", gt: "greaterThan", gte: "greaterThanOrEqualTo" }[kind];

        return this.record(check, value);
    }

    /** Less than a number; on a size, the file holds fewer. */
    lessThan(value: number): this {
        return this.compare("lt", value);
    }

    /** Less than or equal to a number. */
    lessThanOrEqualTo(value: number): this {
        return this.compare("lte", value);
    }

    /** Greater than a number. */
    greaterThan(value: number): this {
        return this.compare("gt", value);
    }

    /** Greater than or equal to a number. */
    greaterThanOrEqualTo(value: number): this {
        return this.compare("gte", value);
    }

    /** Chai's `at.most`, accepted as another spelling of {@link lessThanOrEqualTo}. */
    most(value: number): this {
        return this.compare("lte", value);
    }

    /** Chai's `at.least`, accepted as another spelling of {@link greaterThanOrEqualTo}. */
    least(value: number): this {
        return this.compare("gte", value);
    }

    private change(key: string, value: JsonValue): this {
        if (this.recorded.length === 0) {
            throw new Error(`${key === "level" ? "orWarn()" : "withMessage()"} follows a check: expect(x).to.include("y").orWarn().`);
        }

        for (const entry of this.recorded) {
            this.recorder.update(entry, (current) => {
                (current.assert as JsonObject)[key] = value;
            });
        }

        return this;
    }

    /** Lowers the assertion from an error (the default) to a warning. */
    orWarn(): this {
        return this.change("level", "warn");
    }

    /** The message shown when the assertion fails. */
    withMessage(message: string): this {
        return this.change("message", message);
    }
}

/**
 * Starts an assertion. Its argument is the thing checked: a value (`settings.at("a")`), a file
 * (`settings`), or a size of a file (`settings.byteCount`). Every assertion ends in a method call.
 *
 * ```ts
 * expect( settings.at("permissions.allow") ).to.include("Bash(acme-commit.sh:*)");
 * expect( settings.at("permissions.allow") ).to.have.unique.members();
 * expect( overrideFile.byteCount ).to.be.lessThan(32768).orWarn().withMessage("Codex cuts project instructions off at 32 KiB.");
 * expect( oldPluginManifest ).to.not.exist();
 * ```
 */
export function expect(subject: ExpectSubject): Expectation {
    if (isSize(subject)) {
        const owner = sizeOwners.get(subject);

        if (owner === undefined) {
            throw new Error("expect() takes a value, a file or a size from editor(config).file(...).");
        }

        return new Expectation(subject, owner);
    }

    if (!(subject instanceof ValueHandleImpl)) {
        throw new Error("expect() takes a value, a file or a size from editor(config).file(...).");
    }

    return new Expectation(subject, recorderOf(subject));
}

/** Which recorder each size reference belongs to. */
const sizeOwners = new WeakMap<SizeReference, Recorder>();

for (const [name, measure] of [
    ["byteCount", "bytes"],
    ["characterCount", "characters"],
    ["tokenCount", "tokens"],
] as const) {
    Object.defineProperty(FileHandleImpl.prototype, name, {
        get(this: FileHandleImpl) {
            const reference: SizeReference = Object.freeze({ kind: "size", file: this.file, measure });

            sizeOwners.set(reference, (this as unknown as { recorder: Recorder }).recorder);

            return reference;
        },
        configurable: true,
    });
}
