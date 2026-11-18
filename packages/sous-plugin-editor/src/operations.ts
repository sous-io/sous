/**
 * The operations (spec 07, "The Operations"; spec 12, "Every operation defines `up` and `down`").
 * Each is defined ONCE here, with its parameters, its `order`, `up`, `down` and the automatic
 * assertion that goes with it. The manifest form, the object style and the chain are all made from
 * these definitions, and every shorthand or alias is a name for one of them with some options set.
 *
 * - `up` makes the operation true and returns a record of what it changed (plain JSON, kept in the
 *   history). It is given the record of an earlier run, so a record keeps what was there before
 *   Sous first acted.
 * - `down` undoes it from that record: a value is restored, an item Sous added is removed.
 * - An operation that cannot be carried out (`ensureIncludes` on a value that is not a list)
 *   throws `EditNotPossible`; the editor skips it with a warning, and its assertion then fails.
 */

import {
    deepEqual,
    formatPath,
    isJsonObject,
    parseLines,
    parsePath,
    type CommentStyle,
    type DocNode,
    type JsonObject,
    type JsonValue,
    type LinePosition,
    type LinesDocument,
    type PathSegment,
} from "@sous-io/documents";
import { compareItems, contains, fingerprint, isSorted, matchesFields, sortOptions, toRegExp } from "./checks.js";
import { commentStyleFor, linesOfText, openDocument, type EditorFormat } from "./documents-adapter.js";
import type { FileSession } from "./session.js";
import type { CheckSpec, OperationInfo, OperationScope } from "./types.js";

/** An operation that cannot be made on this document as it is. Skipped with a warning, never thrown out. */
export class EditNotPossible extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EditNotPossible";
    }
}

/** Parameters that are wrong as written: a `ConfigError` when the config is checked. */
export class OperationParamsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "OperationParamsError";
    }
}

/** What `up` and `down` act on. */
export interface OperationContext {
    /** The file being edited. */
    readonly session: FileSession;
    /** The node at the operation's `path`. Opening it parses the file. */
    node(): DocNode;
    /** The operation's path (`""` is the root). */
    readonly path: string;
}

/** One automatic assertion an operation implies. */
export interface ImpliedCheck extends CheckSpec {}

/** One operation. */
export interface OperationDefinition {
    readonly name: string;
    readonly order: number;
    readonly scope: OperationScope;
    /** It acts every time it runs (`append` adds again): Sous runs it once per declaration. */
    readonly action?: boolean;
    readonly summary: string;
    /** Its parameters besides `path` and `assertion`. */
    readonly params: readonly string[];
    /** The chain's positional parameters, in order. */
    readonly args: readonly string[];
    /** Checks and fills its parameters. @throws OperationParamsError */
    normalize(raw: JsonObject): JsonObject;
    up(ctx: OperationContext, params: JsonObject, previous: JsonValue | undefined): JsonValue;
    down(ctx: OperationContext, params: JsonObject, record: JsonValue): void;
    /** Combines the record of an earlier run with this run's. Default: the earlier one, when it changed something. */
    mergeRecords?(previous: JsonValue, next: JsonValue): JsonValue;
    /** The automatic assertions. */
    assertions(params: JsonObject, path: string): ImpliedCheck[];
}

/** Another name for an operation: an alias, or a shorthand with options set. */
export interface AliasDefinition {
    readonly name: string;
    /** The operation it is a name for. */
    readonly target: string;
    /** What it stands for, for the docs: `ensureIncludes with position: first`. */
    readonly means: string;
    readonly params: readonly string[];
    readonly args: readonly string[];
    /** Its parameters as the operation's. */
    toCore(raw: JsonObject): JsonObject;
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const COMMON = ["path", "assertion"];

function changed(record: JsonValue | undefined): boolean {
    if (!isJsonObject(record)) {
        return false;
    }

    if (record.changed === true || record.created === true || record.added === true || record.renamed === true) {
        return true;
    }

    if (typeof record.action === "string" && record.action !== "none") {
        return true;
    }

    return Object.values(record).some((value) => Array.isArray(value) && value.length > 0);
}

function keepEarlier(previous: JsonValue, next: JsonValue): JsonValue {
    return changed(previous) ? previous : next;
}

/** Joins two records whose lists say what was added or removed, keeping the earlier entries first. */
function joinLists(...keys: string[]) {
    return (previous: JsonValue, next: JsonValue): JsonValue => {
        if (!isJsonObject(previous) || !isJsonObject(next)) {
            return next;
        }

        const joined: JsonObject = { ...next };

        for (const key of keys) {
            const before = Array.isArray(previous[key]) ? (previous[key] as JsonValue[]) : [];
            const after = Array.isArray(next[key]) ? (next[key] as JsonValue[]) : [];

            joined[key] = [...before, ...after.filter((item) => !before.some((old) => deepEqual(old, item)))];
        }

        return joined;
    };
}

function requireKey(raw: JsonObject, key: string, operation: string): JsonValue {
    if (raw[key] === undefined) {
        throw new OperationParamsError(`'${operation}' needs '${key}'.`);
    }

    return raw[key]!;
}

function requireString(raw: JsonObject, key: string, operation: string): string {
    const value = requireKey(raw, key, operation);

    if (typeof value !== "string") {
        throw new OperationParamsError(`'${operation}': '${key}' must be a string.`);
    }

    return value;
}

function optionalString(raw: JsonObject, key: string, operation: string): string | undefined {
    const value = raw[key];

    if (value !== undefined && typeof value !== "string") {
        throw new OperationParamsError(`'${operation}': '${key}' must be a string.`);
    }

    return value;
}

function checkPath(raw: JsonObject, operation: string): void {
    const path = raw.path;

    if (path === undefined || path === null) {
        return;
    }

    if (typeof path !== "string") {
        throw new OperationParamsError(`'${operation}': 'path' must be a string.`);
    }

    // A `${var}` in a path is checked once it is substituted, when the edit is applied.
    if (path.includes("${")) {
        return;
    }

    try {
        parsePath(path);
    } catch (error) {
        throw new OperationParamsError(`'${operation}': ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** A list from `items`, or `item`. */
function itemsOf(raw: JsonObject, operation: string, single = "item", plural = "items"): JsonValue[] {
    if (raw[plural] !== undefined) {
        return Array.isArray(raw[plural]) ? [...(raw[plural] as JsonValue[])] : [raw[plural]!];
    }

    if (raw[single] !== undefined) {
        return [raw[single]!];
    }

    throw new OperationParamsError(`'${operation}' needs '${plural}' (or '${single}').`);
}

function without(raw: JsonObject, ...keys: string[]): JsonObject {
    return Object.fromEntries(Object.entries(raw).filter(([key]) => !keys.includes(key)));
}

/** Only the given keys of an object, dropping those left out. */
function pick(raw: JsonObject, keys: readonly string[]): JsonObject {
    return Object.fromEntries(Object.entries(raw).filter(([key, value]) => keys.includes(key) && value !== undefined));
}

/** Where to put what an operation adds. */
type Position =
    | { kind: "default" }
    | { kind: "start" }
    | { kind: "end" }
    | { kind: "index"; index: number }
    | { kind: "after"; anchor: JsonValue }
    | { kind: "before"; anchor: JsonValue };

/** Reads `position`. @throws OperationParamsError */
export function parsePosition(value: JsonValue | undefined, operation = "position"): Position {
    if (value === undefined || value === null) return { kind: "default" };
    if (value === "first" || value === "start") return { kind: "start" };
    if (value === "last" || value === "end") return { kind: "end" };
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return { kind: "index", index: value };

    if (isJsonObject(value)) {
        if (value.after !== undefined) return { kind: "after", anchor: value.after };
        if (value.before !== undefined) return { kind: "before", anchor: value.before };
        if (typeof value.line === "number" && Number.isInteger(value.line) && value.line >= 1) return { kind: "index", index: value.line - 1 };
        if (typeof value.index === "number" && Number.isInteger(value.index) && value.index >= 0) return { kind: "index", index: value.index };
    }

    throw new OperationParamsError(
        `'${operation}': 'position' must be first, last, start, end, an index from 0, { after: ... }, { before: ... } or { line: n }.`,
    );
}

/** Where a placement goes in a list of this length. An anchor that is missing means the end. */
function placementIndex(items: readonly JsonValue[], position: Position): number {
    switch (position.kind) {
        case "start":
            return 0;
        case "index":
            return Math.min(position.index, items.length);
        case "after": {
            const at = items.findIndex((item) => deepEqual(item, position.anchor));

            return at === -1 ? items.length : at + 1;
        }
        case "before": {
            const at = items.findIndex((item) => deepEqual(item, position.anchor));

            return at === -1 ? items.length : at;
        }
        default:
            return items.length;
    }
}

function listOf(node: DocNode): JsonValue[] {
    const value = node.get();

    return Array.isArray(value) ? value : [];
}

/** Makes sure a list is there to add to: a missing one is created; anything else cannot be. */
function prepareList(node: DocNode, operation: string): JsonValue[] {
    const value = node.get();

    if (value === undefined) {
        node.set([]);

        return [];
    }

    if (!Array.isArray(value)) {
        throw new EditNotPossible(`'${operation}' needs a list at ${node.pathString || "the root"}, and the value there is not one.`);
    }

    return value;
}

function existingList(node: DocNode, operation: string): JsonValue[] | undefined {
    const value = node.get();

    if (value === undefined) {
        return undefined;
    }

    if (!Array.isArray(value)) {
        throw new EditNotPossible(`'${operation}' needs a list at ${node.pathString || "the root"}, and the value there is not one.`);
    }

    return value;
}

function indexOf(items: readonly JsonValue[], value: JsonValue): number {
    return items.findIndex((item) => deepEqual(item, value));
}

function lastIndexOf(items: readonly JsonValue[], value: JsonValue): number {
    for (let index = items.length - 1; index >= 0; index--) {
        if (deepEqual(items[index], value)) {
            return index;
        }
    }

    return -1;
}

function removeFirst(node: DocNode, value: JsonValue): void {
    const index = indexOf(listOf(node), value);

    if (index !== -1) {
        node.removeAt(index);
    }
}

/**
 * Lines to edit, as the library's lines document: the whole text at the root, or a string value at
 * a path. `save` writes the document back when it changed; every line it did not touch keeps its
 * bytes and its line ending.
 */
interface LinesAccess {
    readonly doc: LinesDocument;
    save(): void;
}

function linesAccess(ctx: OperationContext, operation: string, comment?: CommentStyle): LinesAccess {
    const options = { comment: comment ?? commentStyleFor(ctx.session.file), label: ctx.session.file };

    if (ctx.path === "") {
        const doc = parseLines(ctx.session.text(), options);

        return {
            doc,
            save: () => {
                if (doc.changed()) {
                    ctx.session.setText(doc.toString());
                }
            },
        };
    }

    const node = ctx.node();
    const value = node.get();

    if (value !== undefined && typeof value !== "string") {
        throw new EditNotPossible(`'${operation}' needs text at ${node.pathString}, and the value there is not a string.`);
    }

    const doc = parseLines(value ?? "", options);

    return {
        doc,
        save: () => {
            if (doc.changed()) {
                node.set(doc.toString());
            }
        },
    };
}

/** A position as the library's lines document takes it. An index counts from 0; a line from 1. */
function linePosition(position: Position): LinePosition {
    switch (position.kind) {
        case "start":
            return "start";
        case "index":
            return { line: position.index + 1 };
        case "after":
            return { after: typeof position.anchor === "string" ? position.anchor : JSON.stringify(position.anchor) };
        case "before":
            return { before: typeof position.anchor === "string" ? position.anchor : JSON.stringify(position.anchor) };
        default:
            return "end";
    }
}

/** Runs a block operation, turning a damaged block (a marker without its pair) into a skipped edit. */
function onBlock<T>(operation: string, act: () => T): T {
    try {
        return act();
    } catch (error) {
        if (error instanceof Error && error.name === "ConfigError") {
            throw new EditNotPossible(`'${operation}': ${error.message}`);
        }

        throw error;
    }
}

/** Text to edit: the whole file at the root, or a string value at a path. */
interface TextAccess {
    get(): string;
    set(text: string): void;
}

function textAccess(ctx: OperationContext, operation: string): TextAccess {
    if (ctx.path === "") {
        return { get: () => ctx.session.text(), set: (text) => ctx.session.setText(text) };
    }

    const node = ctx.node();

    return {
        get() {
            const value = node.get();

            if (value !== undefined && typeof value !== "string") {
                throw new EditNotPossible(`'${operation}' needs text at ${node.pathString}, and the value there is not a string.`);
            }

            return value ?? "";
        },
        set: (text) => node.set(text),
    };
}

/** The text a new file starts with, from `content`: a string as it is, a value written in the file's format. */
export function contentText(content: JsonValue | undefined, format: EditorFormat): string {
    if (content === undefined || content === null) {
        return "";
    }

    if (typeof content === "string") {
        return content;
    }

    if (format === "json" || format === "jsonc") {
        return `${JSON.stringify(content, null, 2)}\n`;
    }

    if (format === "yaml" || format === "markdown") {
        const doc = openDocument("", format);

        doc.root().set(content);

        return doc.toString();
    }

    if (!Array.isArray(content)) {
        return JSON.stringify(content);
    }

    return content.length === 0 ? "" : `${content.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`;
}

/** One recorded value change: a path, whether it existed, and what it was. */
interface ValueChange {
    path: PathSegment[];
    existed: boolean;
    previous?: JsonValue;
}

/** Restores recorded value changes, last first. */
function restoreChanges(root: DocNode, changes: readonly ValueChange[]): void {
    for (const change of [...changes].reverse()) {
        const node = root.atPath(change.path);

        if (change.existed) {
            node.set(change.previous ?? null);
        } else {
            node.delete();
        }
    }
}

/** Merges `value` into the node: objects key by key, lists by adding missing items, anything else set. */
function mergeInto(node: DocNode, value: JsonValue, ifMissing: boolean, changes: ValueChange[], added: JsonObject[]): void {
    const current = node.get();

    if (isJsonObject(value) && isJsonObject(current)) {
        for (const [key, child] of Object.entries(value)) {
            mergeInto(node.atPath([key]), child, ifMissing, changes, added);
        }

        return;
    }

    if (Array.isArray(value) && Array.isArray(current)) {
        if (ifMissing) {
            return;
        }

        for (const item of value) {
            if (indexOf(listOf(node), item) === -1) {
                node.append(item);
                added.push({ path: [...node.path], item });
            }
        }

        return;
    }

    if (current === undefined) {
        node.set(value);
        changes.push({ path: [...node.path], existed: false });

        return;
    }

    if (!ifMissing && !deepEqual(current, value)) {
        node.set(value);
        changes.push({ path: [...node.path], existed: true, previous: current });
    }
}

/** Undoes a merge: removes the items it added, then restores the values it changed. */
function undoMerge(root: DocNode, record: JsonValue): void {
    if (!isJsonObject(record)) {
        return;
    }

    for (const entry of [...((record.added as JsonObject[] | undefined) ?? [])].reverse()) {
        removeFirst(root.atPath(entry.path as PathSegment[]), entry.item!);
    }

    restoreChanges(root, (record.changes as unknown as ValueChange[] | undefined) ?? []);
}

function mergeChangeRecords(previous: JsonValue, next: JsonValue): JsonValue {
    if (!isJsonObject(previous) || !isJsonObject(next)) {
        return next;
    }

    const before = (previous.changes as unknown as ValueChange[] | undefined) ?? [];
    const after = (next.changes as unknown as ValueChange[] | undefined) ?? [];
    const key = (change: ValueChange) => formatPath(change.path);
    const known = new Set(before.map(key));
    const joined = joinLists("added")(previous, next) as JsonObject;

    joined.changes = [...before, ...after.filter((change) => !known.has(key(change)))] as unknown as JsonValue;

    return joined;
}

/** A record of one value replaced: whether Sous changed it, whether it existed, what it was. */
function setValue(node: DocNode, value: JsonValue): JsonValue {
    const existed = node.exists();
    const current = node.get();

    if (existed && deepEqual(current, value)) {
        return { changed: false };
    }

    node.set(value);

    return existed ? { changed: true, existed: true, previous: current! } : { changed: true, existed: false };
}

function restoreValue(node: DocNode, record: JsonValue): void {
    if (!isJsonObject(record) || record.changed !== true) {
        return;
    }

    if (record.existed === true) {
        node.set(record.previous ?? null);
    } else {
        node.delete();
    }
}

function deleteValue(node: DocNode): JsonValue {
    if (!node.exists()) {
        return { changed: false };
    }

    const previous = node.get()!;

    node.delete();

    return { changed: true, existed: true, previous };
}

function isEmpty(value: JsonValue | undefined): boolean {
    return value === null || value === "" || (Array.isArray(value) && value.length === 0) || (isJsonObject(value) && Object.keys(value).length === 0);
}

function stringList(raw: JsonObject, key: string, operation: string): string[] {
    const value = requireKey(raw, key, operation);
    const list = Array.isArray(value) ? value : [value];

    if (!list.every((item) => typeof item === "string")) {
        throw new OperationParamsError(`'${operation}': '${key}' must be a string or a list of strings.`);
    }

    return list as string[];
}

function byField(raw: JsonObject, operation: string): string | undefined {
    return optionalString(raw, "by", operation);
}

function sortParams(raw: JsonObject, operation: string): JsonObject {
    const by = byField(raw, operation);

    if (raw.descending !== undefined && typeof raw.descending !== "boolean") {
        throw new OperationParamsError(`'${operation}': 'descending' must be true or false.`);
    }

    return { ...raw, ...(by === undefined ? {} : { by }) };
}

/** The object `where` or `match` must be. */
function fieldsParam(raw: JsonObject, key: string, operation: string): JsonObject {
    const value = requireKey(raw, key, operation);

    if (!isJsonObject(value)) {
        throw new OperationParamsError(`'${operation}': '${key}' must be an object of fields to match.`);
    }

    return value;
}

/**
 * The comment style a block's markers are written in: `comment` when given (`"#"`, or
 * `{ start: "/*", end: "*\/" }`), otherwise the file's own.
 */
function commentOf(ctx: OperationContext, params: JsonObject): CommentStyle {
    const comment = params.comment;

    if (typeof comment === "string") {
        return { open: comment };
    }

    if (isJsonObject(comment) && typeof comment.start === "string") {
        return typeof comment.end === "string" ? { open: comment.start, close: comment.end } : { open: comment.start };
    }

    return commentStyleFor(ctx.session.file);
}

// ---------------------------------------------------------------------------------------------
// The operations
// ---------------------------------------------------------------------------------------------

const definitions: OperationDefinition[] = [];

function define(definition: Omit<OperationDefinition, "params" | "normalize"> & { params: readonly string[]; normalize?: (raw: JsonObject) => JsonObject }): void {
    const allowed = new Set([...COMMON, ...definition.params]);

    definitions.push({
        ...definition,
        normalize(raw) {
            for (const key of Object.keys(raw)) {
                if (!allowed.has(key)) {
                    throw new OperationParamsError(
                        `'${definition.name}' has no parameter '${key}'. Its parameters: ${["path", ...definition.params].join(", ")}.`,
                    );
                }
            }

            if (raw.assertion !== undefined && raw.assertion !== "none") {
                throw new OperationParamsError(`'${definition.name}': 'assertion' can only be "none".`);
            }

            checkPath(raw, definition.name);

            return definition.normalize ? definition.normalize(raw) : raw;
        },
    });
}

// --- Files and folders (spec 12) ---------------------------------------------------------------

define({
    name: "ensureFileExists",
    order: 0,
    scope: "file",
    summary: "The file exists. A missing file is created with `content`; an existing one is left exactly as it is.",
    params: ["content"],
    args: ["content"],
    up(ctx, params) {
        if (ctx.session.exists()) {
            return { created: false };
        }

        ctx.session.setText(contentText(params.content, ctx.session.format));

        return { created: true };
    },
    // The file a rollback removes is the editor's to remove (it backs it up first), once no entry names it.
    down() {},
    assertions: () => [{ check: "fileExists", arg: true, path: "" }],
});

define({
    name: "ensureDirectoryExists",
    order: 0,
    scope: "directory",
    summary: "The folders exist. Each level Sous creates is recorded; a rollback removes the ones that are empty.",
    params: ["paths"],
    args: ["paths"],
    normalize(raw) {
        return { ...raw, paths: stringList(raw, "paths", "ensureDirectoryExists") };
    },
    // Folders are made and removed by the editor itself, which knows the project root.
    up: () => null,
    down() {},
    assertions: (params) => (params.paths as string[]).map((dir) => ({ check: "directoryExists", arg: dir, path: "" })),
});

// --- Structure ---------------------------------------------------------------------------------

for (const [name, type, empty] of [
    ["ensureObject", "object", {}],
    ["ensureList", "array", []],
] as const) {
    define({
        name,
        order: 10,
        scope: "document",
        summary: `The value is ${type === "object" ? "an object" : "a list"}; anything else is replaced by an empty one.`,
        params: [],
        args: [],
        up(ctx) {
            const node = ctx.node();
            const value = node.get();

            if (type === "object" ? isJsonObject(value) : Array.isArray(value)) {
                return { changed: false };
            }

            return setValue(node, type === "object" ? { ...empty } : [...(empty as unknown as JsonValue[])]);
        },
        down: (ctx, _params, record) => restoreValue(ctx.node(), record),
        mergeRecords: keepEarlier,
        assertions: (_params, path) => [{ check: "type", arg: type, path }],
    });
}

define({
    name: "wrapInList",
    order: 10,
    scope: "document",
    summary: "A value that is not a list becomes a list holding it.",
    params: [],
    args: [],
    up(ctx) {
        const node = ctx.node();
        const value = node.get();

        return value === undefined || Array.isArray(value) ? { changed: false } : setValue(node, [value]);
    },
    down: (ctx, _params, record) => restoreValue(ctx.node(), record),
    mergeRecords: keepEarlier,
    assertions: () => [],
});

define({
    name: "unwrapList",
    order: 10,
    scope: "document",
    summary: "A list of exactly one item becomes that item.",
    params: [],
    args: [],
    up(ctx) {
        const node = ctx.node();
        const value = node.get();

        return Array.isArray(value) && value.length === 1 ? setValue(node, value[0]!) : { changed: false };
    },
    down: (ctx, _params, record) => restoreValue(ctx.node(), record),
    mergeRecords: keepEarlier,
    assertions: () => [],
});

// --- Any value ---------------------------------------------------------------------------------

define({
    name: "set",
    order: 20,
    scope: "document",
    summary: "The path has exactly this value. With `ifMissing: true`, only a missing value is set.",
    params: ["value", "ifMissing"],
    args: ["value"],
    normalize(raw) {
        requireKey(raw, "value", "set");

        if (raw.ifMissing !== undefined && typeof raw.ifMissing !== "boolean") {
            throw new OperationParamsError("'set': 'ifMissing' must be true or false.");
        }

        return raw;
    },
    up(ctx, params) {
        const node = ctx.node();

        if (params.ifMissing === true && node.exists()) {
            return { changed: false };
        }

        return setValue(node, params.value!);
    },
    down: (ctx, _params, record) => restoreValue(ctx.node(), record),
    mergeRecords: keepEarlier,
    assertions: (params, path) =>
        params.ifMissing === true ? [{ check: "exists", arg: true, path }] : [{ check: "equals", arg: params.value!, path }],
});

define({
    name: "setIfEquals",
    order: 20,
    scope: "document",
    summary: "Sets the value only while the path holds `equals`.",
    params: ["value", "equals"],
    args: ["value", "equals"],
    normalize(raw) {
        requireKey(raw, "value", "setIfEquals");
        requireKey(raw, "equals", "setIfEquals");

        return raw;
    },
    up(ctx, params) {
        const node = ctx.node();

        return deepEqual(node.get(), params.equals) ? setValue(node, params.value!) : { changed: false };
    },
    down: (ctx, _params, record) => restoreValue(ctx.node(), record),
    mergeRecords: keepEarlier,
    assertions: () => [],
});

define({
    name: "renameKey",
    order: 20,
    scope: "document",
    summary: "The key at `path` is renamed to `name`, keeping its place and value.",
    params: ["name"],
    args: ["name"],
    normalize(raw) {
        requireString(raw, "name", "renameKey");

        if (typeof raw.path !== "string" || raw.path === "") {
            throw new OperationParamsError("'renameKey' needs the 'path' of the key to rename.");
        }

        return raw;
    },
    up(ctx, params) {
        const node = ctx.node();
        const target = node.parent().atPath([params.name as string]);

        if (!node.exists() || target.exists()) {
            return { renamed: false };
        }

        node.rename(params.name as string);

        return { renamed: true };
    },
    down(ctx, params, record) {
        if (isJsonObject(record) && record.renamed === true) {
            const node = ctx.node();
            const renamed = node.parent().atPath([params.name as string]);
            const last = node.path[node.path.length - 1];

            if (renamed.exists() && typeof last === "string") {
                renamed.rename(last);
            }
        }
    },
    mergeRecords: keepEarlier,
    assertions(params, path) {
        const segments = parsePath(path);
        const renamed = formatPath([...segments.slice(0, -1), params.name as string]);

        return [
            { check: "exists", arg: true, path: renamed },
            { check: "exists", arg: false, path },
        ];
    },
});

// --- Objects -----------------------------------------------------------------------------------

define({
    name: "merge",
    order: 25,
    scope: "document",
    summary:
        "The object has these keys with these values, deeply. A list in `value` adds its missing items. With `ifMissing: true`, only missing keys are added.",
    params: ["value", "ifMissing"],
    args: ["value"],
    normalize(raw) {
        requireKey(raw, "value", "merge");

        return raw;
    },
    up(ctx, params) {
        const changes: ValueChange[] = [];
        const added: JsonObject[] = [];

        mergeInto(ctx.node(), params.value!, params.ifMissing === true, changes, added);

        return { changes: changes as unknown as JsonValue, added };
    },
    down(ctx, _params, record) {
        undoMerge(ctx.session.document().root(), record);
    },
    mergeRecords: mergeChangeRecords,
    assertions: (params, path) => (params.ifMissing === true ? [] : [{ check: "includes", arg: params.value!, path }]),
});

define({
    name: "deleteKeys",
    order: 50,
    scope: "document",
    summary: "None of these keys exist in the object.",
    params: ["keys"],
    args: ["keys"],
    normalize: (raw) => ({ ...raw, keys: stringList(raw, "keys", "deleteKeys") }),
    up(ctx, params) {
        const node = ctx.node();
        const changes: ValueChange[] = [];

        for (const key of params.keys as string[]) {
            const child = node.atPath([key]);

            if (child.exists()) {
                changes.push({ path: [...child.path], existed: true, previous: child.get()! });
                child.delete();
            }
        }

        return { changes: changes as unknown as JsonValue };
    },
    down: (ctx, _params, record) => undoMerge(ctx.session.document().root(), record),
    mergeRecords: mergeChangeRecords,
    assertions: (params, path) => (params.keys as string[]).map((key) => ({ check: "exists", arg: false, path: formatPath([...parsePath(path), key]) })),
});

define({
    name: "keepOnlyKeys",
    order: 50,
    scope: "document",
    summary: "The object has no keys but these.",
    params: ["keys"],
    args: ["keys"],
    normalize: (raw) => ({ ...raw, keys: stringList(raw, "keys", "keepOnlyKeys") }),
    up(ctx, params) {
        const node = ctx.node();
        const keep = new Set(params.keys as string[]);
        const changes: ValueChange[] = [];

        for (const key of node.keys()) {
            if (!keep.has(key)) {
                const child = node.atPath([key]);

                changes.push({ path: [...child.path], existed: true, previous: child.get()! });
                child.delete();
            }
        }

        return { changes: changes as unknown as JsonValue };
    },
    down: (ctx, _params, record) => undoMerge(ctx.session.document().root(), record),
    mergeRecords: mergeChangeRecords,
    assertions: () => [],
});

define({
    name: "sortKeys",
    order: 95,
    scope: "document",
    summary: "The object's keys are in order. Not undone: an order is not a value.",
    params: [],
    args: [],
    up(ctx) {
        const node = ctx.node();
        const value = node.get();

        if (!isJsonObject(value)) {
            if (value === undefined) {
                return null;
            }

            throw new EditNotPossible(`'sortKeys' needs an object at ${node.pathString || "the root"}, and the value there is not one.`);
        }

        // The library moves each key with its own text, so comments and layout stay with it.
        node.sortKeys((a, b) => compareItems(a, b));

        return null;
    },
    down() {},
    assertions: (_params, path) => [{ check: "sortedKeys", arg: true, path }],
});

/** The object at an operation's path, or `undefined` when there is nothing there. */
function objectAt(ctx: OperationContext, operation: string): DocNode | undefined {
    const node = ctx.node();
    const value = node.get();

    if (value === undefined) {
        return undefined;
    }

    if (!isJsonObject(value)) {
        throw new EditNotPossible(`'${operation}' needs an object at ${node.pathString || "the root"}, and the value there is not one.`);
    }

    return node;
}

for (const [name, where] of [
    ["moveKeyBefore", "before"],
    ["moveKeyAfter", "after"],
] as const) {
    define({
        name,
        order: 95,
        scope: "document",
        summary: `The object's key \`key\` comes just ${where} the key \`anchor\`. Nothing happens when either is missing. Not undone: an order is not a value.`,
        params: ["key", "anchor"],
        args: ["key", "anchor"],
        normalize(raw) {
            requireString(raw, "key", name);
            requireString(raw, "anchor", name);

            return raw;
        },
        up(ctx, params) {
            const node = objectAt(ctx, name);

            if (node !== undefined) {
                if (where === "before") node.moveKeyBefore(params.key as string, params.anchor as string);
                else node.moveKeyAfter(params.key as string, params.anchor as string);
            }

            return null;
        },
        down() {},
        assertions: () => [],
    });
}

for (const [name, where] of [
    ["moveKeyFirst", "first"],
    ["moveKeyLast", "last"],
] as const) {
    define({
        name,
        order: 95,
        scope: "document",
        summary: `The object's key \`key\` comes ${where}. Nothing happens when it is missing. Not undone: an order is not a value.`,
        params: ["key"],
        args: ["key"],
        normalize(raw) {
            requireString(raw, "key", name);

            return raw;
        },
        up(ctx, params) {
            const node = objectAt(ctx, name);

            if (node !== undefined && node.keys().includes(params.key as string)) {
                if (where === "first") node.moveKeyFirst(params.key as string);
                else node.moveKeyLast(params.key as string);
            }

            return null;
        },
        down() {},
        assertions: () => [],
    });
}

define({
    name: "delete",
    order: 50,
    scope: "document",
    summary: "The path does not exist.",
    params: [],
    args: [],
    up: (ctx) => deleteValue(ctx.node()),
    down: (ctx, _params, record) => restoreValue(ctx.node(), record),
    mergeRecords: keepEarlier,
    assertions: (_params, path) => [{ check: "exists", arg: false, path }],
});

define({
    name: "deleteIfEquals",
    order: 50,
    scope: "document",
    summary: "Deletes the value only while it equals `value`.",
    params: ["value"],
    args: ["value"],
    normalize(raw) {
        requireKey(raw, "value", "deleteIfEquals");

        return raw;
    },
    up(ctx, params) {
        const node = ctx.node();

        return deepEqual(node.get(), params.value) ? deleteValue(node) : { changed: false };
    },
    down: (ctx, _params, record) => restoreValue(ctx.node(), record),
    mergeRecords: keepEarlier,
    assertions: (params, path) => [{ check: "equals", arg: params.value!, path, not: true }],
});

define({
    name: "deleteIfEmpty",
    order: 50,
    scope: "document",
    summary: "Deletes the value only while it is empty: `{}`, `[]`, `\"\"` or null.",
    params: [],
    args: [],
    up(ctx) {
        const node = ctx.node();

        return node.exists() && isEmpty(node.get()) ? deleteValue(node) : { changed: false };
    },
    down: (ctx, _params, record) => restoreValue(ctx.node(), record),
    mergeRecords: keepEarlier,
    assertions: () => [],
});

// --- Lists -------------------------------------------------------------------------------------

define({
    name: "upsertWhere",
    order: 30,
    scope: "document",
    summary: "The list has an item matching `match`, equal to `item`: a matching item is replaced, or the item is added.",
    params: ["match", "item"],
    args: ["match", "item"],
    normalize(raw) {
        fieldsParam(raw, "match", "upsertWhere");
        requireKey(raw, "item", "upsertWhere");

        return raw;
    },
    up(ctx, params): JsonValue {
        const node = ctx.node();
        const items = prepareList(node, "upsertWhere");
        const index = items.findIndex((item) => matchesFields(item, params.match!));

        if (index === -1) {
            node.append(params.item);

            return { action: "added" };
        }

        if (deepEqual(items[index], params.item)) {
            return { action: "none" };
        }

        node.atIndex(index).set(params.item);

        return { action: "replaced", previous: items[index]! };
    },
    down(ctx, params, record) {
        if (!isJsonObject(record)) return;

        const node = ctx.node();
        const index = listOf(node).findIndex((item) => matchesFields(item, params.match!));

        if (index === -1) return;

        if (record.action === "added") {
            node.removeAt(index);
        } else if (record.action === "replaced") {
            node.atIndex(index).set(record.previous ?? null);
        }
    },
    mergeRecords: keepEarlier,
    assertions: (params, path) => [{ check: "itemWhere", arg: { match: params.match!, item: params.item! }, path }],
});

define({
    name: "ensureIncludes",
    order: 40,
    scope: "document",
    summary:
        "The list contains each of these items; missing ones are added. With `position` (first, last, or an index), the items are at that place, moved there if needed.",
    params: ["items", "item", "position"],
    args: ["items"],
    normalize(raw) {
        const items = itemsOf(raw, "ensureIncludes");

        parsePosition(raw.position, "ensureIncludes");

        return { ...without(raw, "item"), items };
    },
    up(ctx, params) {
        const node = ctx.node();
        const items = params.items as JsonValue[];
        const position = parsePosition(params.position);
        const added: JsonValue[] = [];
        const moved: JsonObject[] = [];
        let list = prepareList(node, "ensureIncludes");

        const take = (item: JsonValue): void => {
            const index = indexOf(list, item);

            if (index === -1) {
                added.push(item);
            } else {
                moved.push({ item, from: index });
                node.removeAt(index);
                list = listOf(node);
            }
        };

        if (position.kind === "start" || position.kind === "index") {
            const base = position.kind === "start" ? 0 : position.index;

            items.forEach((item, offset) => {
                const want = Math.min(base + offset, list.length);

                if (deepEqual(list[want], item)) return;

                take(item);
                node.insertAt(Math.min(base + offset, list.length), item);
                list = listOf(node);
            });
        } else if (position.kind === "end") {
            const tail = list.slice(Math.max(0, list.length - items.length));

            if (!(tail.length === items.length && tail.every((item, index) => deepEqual(item, items[index])))) {
                for (const item of items) {
                    if (indexOf(list, item) !== -1) take(item);
                    else added.push(item);
                }

                for (const item of items) node.append(item);
            }
        } else {
            let insertAt = -1;

            for (const item of items) {
                if (indexOf(list, item) !== -1) continue;

                insertAt = insertAt === -1 ? placementIndex(list, position) : insertAt;
                node.insertAt(insertAt, item);
                added.push(item);
                insertAt += 1;
                list = listOf(node);
            }
        }

        // An item that was moved and added in one run was only added.
        return { added, moved: moved.filter((entry) => !added.some((item) => deepEqual(item, entry.item))) };
    },
    down(ctx, _params, record) {
        if (!isJsonObject(record)) return;

        const node = ctx.node();

        for (const item of (record.added as JsonValue[] | undefined) ?? []) {
            removeFirst(node, item);
        }

        for (const entry of [...((record.moved as JsonObject[] | undefined) ?? [])].reverse()) {
            const index = indexOf(listOf(node), entry.item!);
            const from = entry.from as number;

            if (index !== -1 && index !== from) {
                node.removeAt(index);
                node.insertAt(Math.min(from, listOf(node).length), entry.item!);
            }
        }
    },
    mergeRecords: joinLists("added", "moved"),
    assertions(params, path) {
        const items = params.items as JsonValue[];
        const position = parsePosition(params.position);

        if (position.kind === "start" || position.kind === "index") {
            const base = position.kind === "start" ? 0 : position.index;

            return items.map((item, offset) =>
                base + offset === 0 ? { check: "first", arg: item, path } : { check: "at", arg: { index: base + offset, item }, path },
            );
        }

        if (position.kind === "end" && items.length > 0) {
            return [
                ...items.slice(0, -1).map((item) => ({ check: "includes", arg: item, path })),
                { check: "last", arg: items[items.length - 1]!, path },
            ];
        }

        return items.map((item) => ({ check: "includes", arg: item, path }));
    },
});

define({
    name: "prependIfMissing",
    order: 40,
    scope: "document",
    summary:
        "The list contains each of these items; a missing one goes at the start, in the order given. An item already there stays where it is.",
    params: ["items", "item"],
    args: ["items"],
    normalize(raw) {
        return { ...without(raw, "item"), items: itemsOf(raw, "prependIfMissing") };
    },
    up(ctx, params) {
        const node = ctx.node();
        const items = params.items as JsonValue[];
        const added: JsonValue[] = [];

        prepareList(node, "prependIfMissing");

        // Last first, so the items that were missing end up at the start in the order given.
        for (const item of [...items].reverse()) {
            if (node.prependIfMissing(item)) {
                added.unshift(item);
            }
        }

        return { added };
    },
    down(ctx, _params, record) {
        if (!isJsonObject(record)) return;

        const node = ctx.node();

        for (const item of (record.added as JsonValue[] | undefined) ?? []) {
            removeFirst(node, item);
        }
    },
    mergeRecords: joinLists("added"),
    assertions: (params, path) => (params.items as JsonValue[]).map((item) => ({ check: "includes", arg: item, path })),
});

define({
    name: "append",
    order: 40,
    scope: "document",
    action: true,
    summary:
        "Adds the items, even if they are already there (an action: Sous does it once, when the entry is first applied). `position` puts them first, at an index, or after or before an item.",
    params: ["items", "item", "position"],
    args: ["item"],
    normalize(raw) {
        const items = itemsOf(raw, "append");

        parsePosition(raw.position, "append");

        return { ...without(raw, "item"), items };
    },
    up(ctx, params) {
        const node = ctx.node();
        const position = parsePosition(params.position);
        let list = prepareList(node, "append");
        let index = placementIndex(list, position);
        const added: JsonObject[] = [];

        for (const item of params.items as JsonValue[]) {
            node.insertAt(index, item);
            added.push({ item, index });
            index += 1;
            list = listOf(node);
        }

        return { added };
    },
    down(ctx, _params, record) {
        if (!isJsonObject(record)) return;

        const node = ctx.node();

        for (const entry of [...((record.added as JsonObject[] | undefined) ?? [])].reverse()) {
            const list = listOf(node);
            const at = entry.index as number;
            const index = deepEqual(list[at], entry.item) ? at : lastIndexOf(list, entry.item!);

            if (index !== -1) node.removeAt(index);
        }
    },
    assertions(params, path) {
        const position = parsePosition(params.position);
        const items = params.items as JsonValue[];

        return position.kind === "start" && items.length > 0
            ? [{ check: "first", arg: items[0]!, path }]
            : items.map((item) => ({ check: "includes", arg: item, path }));
    },
});

define({
    name: "removeAt",
    order: 50,
    scope: "document",
    action: true,
    summary: "Removes the item at `index` (an action: Sous does it once, when the entry is first applied).",
    params: ["index"],
    args: ["index"],
    normalize(raw) {
        const index = requireKey(raw, "index", "removeAt");

        if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
            throw new OperationParamsError("'removeAt': 'index' must be a whole number from 0.");
        }

        return raw;
    },
    up(ctx, params) {
        const node = ctx.node();
        const list = existingList(node, "removeAt") ?? [];
        const index = params.index as number;

        if (index >= list.length) {
            return { removed: [] };
        }

        node.removeAt(index);

        return { removed: [{ index, item: list[index]! }] };
    },
    down: (ctx, _params, record) => reinsert(ctx.node(), record),
    assertions: () => [],
});

/** Puts back items a removal recorded, lowest index first. */
function reinsert(node: DocNode, record: JsonValue): void {
    if (!isJsonObject(record)) return;

    const removed = [...((record.removed as JsonObject[] | undefined) ?? [])].sort((a, b) => (a.index as number) - (b.index as number));

    if (removed.length > 0 && !node.exists()) {
        node.set([]);
    }

    for (const entry of removed) {
        node.insertAt(Math.min(entry.index as number, listOf(node).length), entry.item!);
    }
}

define({
    name: "remove",
    order: 50,
    scope: "document",
    summary: "The list contains none of these: `values` (items equal to one of them) or `where` (items matching these fields).",
    params: ["values", "where"],
    args: [],
    normalize(raw) {
        if ((raw.values === undefined) === (raw.where === undefined)) {
            throw new OperationParamsError("'remove' needs exactly one of 'values' and 'where'.");
        }

        if (raw.where !== undefined) {
            fieldsParam(raw, "where", "remove");

            return raw;
        }

        return { ...raw, values: Array.isArray(raw.values) ? raw.values : [raw.values!] };
    },
    up(ctx, params) {
        const node = ctx.node();
        const list = existingList(node, "remove") ?? [];
        const removed: JsonObject[] = [];

        for (let index = list.length - 1; index >= 0; index--) {
            const item = list[index]!;
            const hit = params.where !== undefined ? matchesFields(item, params.where) : (params.values as JsonValue[]).some((value) => deepEqual(value, item));

            if (hit) {
                node.removeAt(index);
                removed.unshift({ index, item });
            }
        }

        return { removed };
    },
    down: (ctx, _params, record) => reinsert(ctx.node(), record),
    mergeRecords: joinLists("removed"),
    assertions: (params, path) =>
        params.where !== undefined
            ? [{ check: "noItemWhere", arg: params.where, path }]
            : (params.values as JsonValue[]).map((value) => ({ check: "excludes", arg: value, path })),
});

define({
    name: "replaceWhere",
    order: 25,
    scope: "document",
    summary: "Every item matching `where` is replaced by `item`.",
    params: ["where", "item"],
    args: ["where", "item"],
    normalize(raw) {
        fieldsParam(raw, "where", "replaceWhere");
        requireKey(raw, "item", "replaceWhere");

        return raw;
    },
    up(ctx, params) {
        const node = ctx.node();
        const list = existingList(node, "replaceWhere") ?? [];
        const replaced: JsonObject[] = [];

        list.forEach((item, index) => {
            if (matchesFields(item, params.where!) && !deepEqual(item, params.item)) {
                node.atIndex(index).set(params.item);
                replaced.push({ index, previous: item });
            }
        });

        return { replaced };
    },
    down(ctx, _params, record) {
        if (!isJsonObject(record)) return;

        const node = ctx.node();

        for (const entry of (record.replaced as JsonObject[] | undefined) ?? []) {
            if ((entry.index as number) < listOf(node).length) {
                node.atIndex(entry.index as number).set(entry.previous ?? null);
            }
        }
    },
    mergeRecords: keepEarlier,
    assertions: () => [],
});

for (const [name, deep] of [
    ["updateWhere", false],
    ["mergeWhere", true],
] as const) {
    define({
        name,
        order: 25,
        scope: "document",
        summary: deep
            ? "Every item matching `where` has `value` merged into it, deeply."
            : "Every item matching `where` has the keys of `value` set on it.",
        params: ["where", "value"],
        args: ["where", "value"],
        normalize(raw) {
            fieldsParam(raw, "where", name);
            fieldsParam(raw, "value", name);

            return raw;
        },
        up(ctx, params) {
            const node = ctx.node();
            const list = existingList(node, name) ?? [];
            const changes: ValueChange[] = [];
            const added: JsonObject[] = [];

            list.forEach((item, index) => {
                if (!matchesFields(item, params.where!)) return;

                const itemNode = node.atIndex(index);

                if (deep) {
                    mergeInto(itemNode, params.value!, false, changes, added);
                } else {
                    for (const [key, value] of Object.entries(params.value as JsonObject)) {
                        const child = itemNode.atPath([key]);
                        const record = setValue(child, value);

                        if (isJsonObject(record) && record.changed === true) {
                            changes.push({ path: [...child.path], existed: record.existed === true, ...(record.existed === true ? { previous: record.previous! } : {}) });
                        }
                    }
                }
            });

            return { changes: changes as unknown as JsonValue, added };
        },
        down: (ctx, _params, record) => undoMerge(ctx.session.document().root(), record),
        mergeRecords: mergeChangeRecords,
        assertions: () => [],
    });
}

define({
    name: "dedupe",
    order: 80,
    scope: "document",
    summary: "The list has no duplicates; the first of each is kept. `by` compares one field. Not undone.",
    params: ["by"],
    args: [],
    normalize(raw) {
        byField(raw, "dedupe");

        return raw;
    },
    up(ctx, params) {
        const node = ctx.node();

        if (existingList(node, "dedupe") !== undefined) {
            const by = params.by as string | undefined;

            node.dedupe(by === undefined ? undefined : (item) => (isJsonObject(item) ? item[by] : item));
        }

        return null;
    },
    down() {},
    assertions: (params, path) => [{ check: "unique", arg: params.by === undefined ? true : { by: params.by }, path }],
});

define({
    name: "sort",
    order: 90,
    scope: "document",
    summary: "The list is in order: numbers by value, text by code point. `by` sorts by one field; `descending: true` reverses. Not undone.",
    params: ["by", "descending"],
    args: [],
    normalize: (raw) => sortParams(raw, "sort"),
    up(ctx, params) {
        const node = ctx.node();
        const list = existingList(node, "sort");
        const options = sortOptions(params);

        if (list === undefined || isSorted(list, options)) {
            return null;
        }

        const sorted = [...list].sort((a, b) => compareItems(a, b, options));

        sorted.forEach((item, index) => {
            if (!deepEqual(item, listOf(node)[index])) {
                node.atIndex(index).set(item);
            }
        });

        return null;
    },
    down() {},
    assertions: (params, path) => {
        const options = sortOptions(params);

        return [{ check: "sorted", arg: options.by === undefined && !options.descending ? true : (options as JsonObject), path }];
    },
});

// --- Text and lines ----------------------------------------------------------------------------

define({
    name: "ensureLine",
    order: 60,
    scope: "document",
    summary:
        "The text contains this line, anywhere. If it is missing it goes at `position`: end (the default), start, an index, { line: n }, { after: \"...\" } or { before: \"...\" }.",
    params: ["line", "position"],
    args: ["line"],
    normalize(raw) {
        requireString(raw, "line", "ensureLine");
        parsePosition(raw.position, "ensureLine");

        return raw;
    },
    up(ctx, params) {
        const { doc, save } = linesAccess(ctx, "ensureLine");

        if (doc.includes(params.line as string)) {
            return { added: false };
        }

        doc.insert(params.line as string, linePosition(parsePosition(params.position)));
        save();

        return { added: true };
    },
    down(ctx, params, record) {
        if (!isJsonObject(record) || record.added !== true) return;

        const { doc, save } = linesAccess(ctx, "ensureLine");
        const index = doc.indexOf(params.line as string);

        if (index !== -1) {
            doc.replaceLines(index, 1, []);
            save();
        }
    },
    mergeRecords: keepEarlier,
    assertions: (params, path) => [{ check: "includesLine", arg: params.line!, path }],
});

define({
    name: "removeLine",
    order: 50,
    scope: "document",
    summary: "The text does not contain this line.",
    params: ["line"],
    args: ["line"],
    normalize(raw) {
        requireString(raw, "line", "removeLine");

        return raw;
    },
    up(ctx, params) {
        const { doc, save } = linesAccess(ctx, "removeLine");
        const removed = doc
            .lines()
            .map((line, index) => (line === params.line ? index : -1))
            .filter((index) => index !== -1);

        if (removed.length > 0) {
            doc.remove(params.line as string);
            save();
        }

        return { removed };
    },
    down(ctx, params, record) {
        if (!isJsonObject(record)) return;

        const removed = (record.removed as number[] | undefined) ?? [];

        if (removed.length === 0) return;

        const { doc, save } = linesAccess(ctx, "removeLine");

        for (const index of removed) {
            doc.replaceLines(Math.min(index, doc.length()), 0, [params.line as string]);
        }

        save();
    },
    mergeRecords: keepEarlier,
    assertions: (params, path) => [{ check: "includesLine", arg: params.line!, path, not: true }],
});

define({
    name: "ensureBlock",
    order: 60,
    scope: "document",
    summary:
        "The text contains a block Sous keeps between two marker lines, `>>> sous managed: <name> (do not edit between these markers)` and `<<< sous managed: <name>`, in the file's comment style, holding exactly `content`.",
    params: ["name", "content", "position", "comment"],
    args: ["name", "content"],
    normalize(raw) {
        requireString(raw, "name", "ensureBlock");
        requireString(raw, "content", "ensureBlock");
        parsePosition(raw.position, "ensureBlock");

        return raw;
    },
    up(ctx, params): JsonValue {
        const { doc, save } = linesAccess(ctx, "ensureBlock", commentOf(ctx, params));
        const name = params.name as string;
        const content = linesOfText(params.content as string);

        return onBlock("ensureBlock", (): JsonValue => {
            const current = doc.block(name);

            if (current !== undefined && deepEqual(current, content)) {
                return { created: false };
            }

            doc.setBlock(name, content, linePosition(parsePosition(params.position)));
            save();

            return current === undefined ? { created: true } : { created: false, previous: current.join("\n") };
        });
    },
    down(ctx, params, record) {
        if (!isJsonObject(record)) return;

        const { doc, save } = linesAccess(ctx, "ensureBlock", commentOf(ctx, params));
        const name = params.name as string;

        onBlock("ensureBlock", () => {
            if (!doc.hasBlock(name)) return;

            if (record.created === true) {
                doc.removeBlock(name);
            } else if (typeof record.previous === "string") {
                doc.setBlock(name, linesOfText(record.previous));
            } else {
                return;
            }

            save();
        });
    },
    mergeRecords: (previous, next) => (isJsonObject(previous) && (previous.created === true || previous.previous !== undefined) ? previous : next),
    assertions: (params, path) => [{ check: "includesBlock", arg: { name: params.name!, content: params.content! }, path }],
});

for (const [name, atEnd] of [
    ["appendText", true],
    ["prependText", false],
] as const) {
    define({
        name,
        order: 60,
        scope: "document",
        action: true,
        summary: `Adds \`value\` to the ${atEnd ? "end" : "start"} of the text (an action: Sous does it once, when the entry is first applied).`,
        params: ["value"],
        args: ["value"],
        normalize(raw) {
            requireString(raw, "value", name);

            return raw;
        },
        up(ctx, params) {
            const access = textAccess(ctx, name);
            const text = access.get();

            access.set(atEnd ? text + (params.value as string) : (params.value as string) + text);

            return { added: true };
        },
        down(ctx, params) {
            const access = textAccess(ctx, name);
            const text = access.get();
            const value = params.value as string;

            if (atEnd && text.endsWith(value)) access.set(text.slice(0, text.length - value.length));
            if (!atEnd && text.startsWith(value)) access.set(text.slice(value.length));
        },
        assertions: (params, path) => (path === "" ? [] : [{ check: "includes", arg: params.value!, path }]),
    });
}

define({
    name: "replaceText",
    order: 60,
    scope: "document",
    summary: "Every occurrence of `match` in the text becomes `value`. Undone by turning `value` back into `match`.",
    params: ["match", "value"],
    args: ["match", "value"],
    normalize(raw) {
        requireString(raw, "match", "replaceText");
        requireString(raw, "value", "replaceText");

        return raw;
    },
    up(ctx, params) {
        const access = textAccess(ctx, "replaceText");
        const text = access.get();
        const match = params.match as string;

        if (match === "" || !text.includes(match)) {
            return { changed: false };
        }

        access.set(text.split(match).join(params.value as string));

        return { changed: true };
    },
    down(ctx, params, record) {
        if (!isJsonObject(record) || record.changed !== true || params.value === "") return;

        const access = textAccess(ctx, "replaceText");

        access.set(access.get().split(params.value as string).join(params.match as string));
    },
    mergeRecords: keepEarlier,
    assertions: (params, path) => (path === "" ? [] : [{ check: "includes", arg: params.match!, path, not: true }]),
});

define({
    name: "replacePattern",
    order: 60,
    scope: "document",
    summary: "Every match of the regular expression `match` (`\"^a\"` or `\"/^a/i\"`) becomes `value`, with `$1` and so on. Not undone.",
    params: ["match", "value"],
    args: ["match", "value"],
    normalize(raw) {
        const match = requireString(raw, "match", "replacePattern");

        requireString(raw, "value", "replacePattern");

        try {
            toRegExp(match);
        } catch (error) {
            throw new OperationParamsError(`'replacePattern': ${error instanceof Error ? error.message : String(error)}`);
        }

        return raw;
    },
    up(ctx, params) {
        const access = textAccess(ctx, "replacePattern");
        const pattern = toRegExp(params.match as string);
        const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
        const text = access.get();
        const next = text.replace(global, params.value as string);

        if (next !== text) access.set(next);

        return null;
    },
    down() {},
    assertions: () => [],
});

// --- Numbers and booleans ----------------------------------------------------------------------

for (const [name, sign] of [
    ["increment", 1],
    ["decrement", -1],
] as const) {
    define({
        name,
        order: 70,
        scope: "document",
        action: true,
        summary: `${sign > 0 ? "Adds" : "Subtracts"} \`value\` (default 1) ${sign > 0 ? "to" : "from"} a number; a missing one counts as 0 (an action: Sous does it once).`,
        params: ["value"],
        args: ["value"],
        normalize(raw) {
            if (raw.value !== undefined && typeof raw.value !== "number") {
                throw new OperationParamsError(`'${name}': 'value' must be a number.`);
            }

            return raw;
        },
        up(ctx, params) {
            const node = ctx.node();
            const current = node.get();

            if (current !== undefined && typeof current !== "number") {
                throw new EditNotPossible(`'${name}' needs a number at ${node.pathString || "the root"}.`);
            }

            return setValue(node, (current ?? 0) + sign * ((params.value as number | undefined) ?? 1));
        },
        down: (ctx, _params, record) => restoreValue(ctx.node(), record),
        assertions: () => [],
    });
}

define({
    name: "toggle",
    order: 70,
    scope: "document",
    action: true,
    summary: "Turns true into false and false into true; a missing value becomes true (an action: Sous does it once).",
    params: [],
    args: [],
    up(ctx) {
        const node = ctx.node();
        const current = node.get();

        if (current !== undefined && typeof current !== "boolean") {
            throw new EditNotPossible(`'toggle' needs true or false at ${node.pathString || "the root"}.`);
        }

        return setValue(node, current !== true);
    },
    down: (ctx, _params, record) => restoreValue(ctx.node(), record),
    assertions: () => [],
});

// ---------------------------------------------------------------------------------------------
// Aliases and shorthands
// ---------------------------------------------------------------------------------------------

const aliases: AliasDefinition[] = [];

function alias(
    name: string,
    target: string,
    means: string,
    options: { params?: readonly string[]; args?: readonly string[]; toCore?: (raw: JsonObject) => JsonObject } = {},
): void {
    const core = definitions.find((definition) => definition.name === target)!;

    aliases.push({
        name,
        target,
        means,
        params: options.params ?? core.params,
        args: options.args ?? core.args,
        toCore(raw) {
            const allowed = new Set([...COMMON, ...(options.params ?? core.params)]);

            for (const key of Object.keys(raw)) {
                if (!allowed.has(key)) {
                    throw new OperationParamsError(`'${name}' has no parameter '${key}'. Its parameters: ${["path", ...(options.params ?? core.params)].join(", ")}.`);
                }
            }

            return options.toCore ? options.toCore(raw) : raw;
        },
    });
}

const itemParams = ["item", "items"];

alias("ensureValue", "set", "set", { params: ["value"] });
alias("replace", "set", "set", { params: ["value"] });
alias("setIfMissing", "set", "set with ifMissing: true", { params: ["value"], toCore: (raw) => ({ ...raw, ifMissing: true }) });
alias("ensureDefault", "set", "set with ifMissing: true", { params: ["value"], toCore: (raw) => ({ ...raw, ifMissing: true }) });
alias("ensureAbsent", "delete", "delete");
alias("ensureKeys", "merge", "merge", { params: ["value"] });
alias("deepMerge", "merge", "merge", { params: ["value"] });
alias("mergeIfMissing", "merge", "merge with ifMissing: true", { params: ["value"], toCore: (raw) => ({ ...raw, ifMissing: true }) });
alias("ensureFirst", "ensureIncludes", "ensureIncludes with position: first", {
    params: itemParams,
    args: ["item"],
    toCore: (raw) => ({ ...raw, position: "first" }),
});
alias("ensureLast", "ensureIncludes", "ensureIncludes with position: last", {
    params: itemParams,
    args: ["item"],
    toCore: (raw) => ({ ...raw, position: "last" }),
});
alias("ensureAt", "ensureIncludes", "ensureIncludes with position: <index>", {
    params: [...itemParams, "index"],
    args: ["index", "item"],
    toCore(raw) {
        if (typeof raw.index !== "number") {
            throw new OperationParamsError("'ensureAt' needs 'index', a whole number from 0.");
        }

        return { ...without(raw, "index"), position: raw.index };
    },
});
alias("appendIfMissing", "ensureIncludes", "ensureIncludes", { params: itemParams, args: ["items"] });
alias("union", "ensureIncludes", "ensureIncludes", { params: itemParams, args: ["items"] });
alias("prepend", "append", "append with position: first", { params: itemParams, args: ["item"], toCore: (raw) => ({ ...raw, position: "first" }) });
alias("insertAt", "append", "append with position: <index>", {
    params: [...itemParams, "index"],
    args: ["index", "item"],
    toCore(raw) {
        if (typeof raw.index !== "number") {
            throw new OperationParamsError("'insertAt' needs 'index', a whole number from 0.");
        }

        return { ...without(raw, "index"), position: raw.index };
    },
});
for (const [name, side] of [
    ["insertBefore", "before"],
    ["insertAfter", "after"],
] as const) {
    alias(name, "append", `append with position: { ${side}: ... }`, {
        params: [...itemParams, side],
        args: [side, "item"],
        toCore(raw) {
            if (raw[side] === undefined) {
                throw new OperationParamsError(`'${name}' needs '${side}', the item to put it ${side}.`);
            }

            return { ...without(raw, side), position: { [side]: raw[side]! } };
        },
    });
}
alias("ensureItemWhere", "upsertWhere", "upsertWhere");
alias("removeValues", "remove", "remove with values: [...]", { params: ["values"], args: ["values"] });
alias("ensureExcludes", "remove", "remove with values: [...]", { params: ["values"], args: ["values"] });
alias("removeValue", "remove", "remove with values: [value]", {
    params: ["value"],
    args: ["value"],
    toCore: (raw) => ({ ...without(raw, "value"), values: [requireKey(raw, "value", "removeValue")] }),
});
alias("removeWhere", "remove", "remove with where: {...}", { params: ["where"], args: ["where"] });
alias("ensureNoItemWhere", "remove", "remove with where: {...}", { params: ["where"], args: ["where"] });
alias("ensureUnique", "dedupe", "dedupe");
alias("dedupeBy", "dedupe", "dedupe with by", {
    args: ["by"],
    toCore(raw) {
        requireString(raw, "by", "dedupeBy");

        return raw;
    },
});
alias("ensureSorted", "sort", "sort");
alias("sortBy", "sort", "sort with by", {
    args: ["by"],
    toCore(raw) {
        requireString(raw, "by", "sortBy");

        return raw;
    },
});
alias("createIfMissing", "ensureFileExists", "ensureFileExists");

// ---------------------------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------------------------

/** Every operation, by name. */
export const OPERATIONS: ReadonlyMap<string, OperationDefinition> = new Map(definitions.map((definition) => [definition.name, definition]));

/** Every alias and shorthand, by name. */
export const ALIASES: ReadonlyMap<string, AliasDefinition> = new Map(aliases.map((entry) => [entry.name, entry]));

/** Whether a name is an operation, an alias or a shorthand. */
export function isOperationName(name: string): boolean {
    return OPERATIONS.has(name) || ALIASES.has(name);
}

/** An operation call resolved to its definition, with its parameters checked and filled. */
export interface ResolvedOperation {
    readonly definition: OperationDefinition;
    /** The name as written (an alias or a shorthand, or the operation's own). */
    readonly written: string;
    readonly params: JsonObject;
    /** The operation's path (`""` is the root). */
    readonly path: string;
    /** False when `assertion: none` drops its automatic assertion. */
    readonly assertion: boolean;
}

/**
 * Resolves an operation by any of its names, and checks its parameters.
 *
 * ```ts
 * resolveOperation("ensureFirst", { path: "permissions.allow", item: "Bash(x)" });
 * // -> { definition: ensureIncludes, written: "ensureFirst",
 * //      params: { path: "permissions.allow", items: ["Bash(x)"], position: "first" }, ... }
 * ```
 *
 * @throws OperationParamsError for an unknown name or wrong parameters.
 */
export function resolveOperation(name: string, raw: JsonValue | undefined): ResolvedOperation {
    if (!isJsonObject(raw)) {
        throw new OperationParamsError(`'${name}' must hold an object with its parameters (use {} when it needs none).`);
    }

    const aliasDefinition = ALIASES.get(name);
    const definition = OPERATIONS.get(aliasDefinition?.target ?? name);

    if (definition === undefined) {
        throw new OperationParamsError(`There is no operation named '${name}'.`);
    }

    const core = aliasDefinition ? aliasDefinition.toCore(raw) : raw;
    const params = definition.normalize(core);
    const path = typeof params.path === "string" ? params.path : "";

    return {
        definition,
        written: name,
        params: without(params, "assertion"),
        path: path === "" || path.includes("${") ? path : formatPath(parsePath(path)),
        assertion: params.assertion !== "none",
    };
}

/** Turns positional chain arguments and an optional options object into an operation's parameters. */
export function chainParams(name: string, args: readonly unknown[]): JsonObject {
    const names = ALIASES.get(name)?.args ?? OPERATIONS.get(name)?.args ?? [];
    const params: JsonObject = {};

    names.forEach((param, index) => {
        if (index < args.length && args[index] !== undefined) {
            params[param] = args[index] as JsonValue;
        }
    });

    const options = args[names.length];

    if (options !== undefined) {
        if (!isJsonObject(options as JsonValue)) {
            throw new OperationParamsError(`'${name}' takes ${names.length === 0 ? "only" : `${names.join(", ")}, then`} an object of options.`);
        }

        Object.assign(params, options);
    }

    return params;
}

/** Every operation, with its aliases, as the service and the docs list them, in order. */
export function operationInfo(): OperationInfo[] {
    return [...OPERATIONS.values()]
        .sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : 1))
        .map((definition) => ({
            name: definition.name,
            order: definition.order,
            scope: definition.scope,
            action: definition.action === true,
            params: definition.params,
            args: definition.args,
            aliases: aliases.filter((entry) => entry.target === definition.name).map((entry) => ({ name: entry.name, means: entry.means })),
            summary: definition.summary,
        }));
}

/** Only the given parameters, for the docs and the identity of a step. */
export { pick as pickParams, contains };
