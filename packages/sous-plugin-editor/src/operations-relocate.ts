/**
 * The operations that put a value or a list item in another place (spec 07, "The Operations").
 * Each is defined once here, the way `operations.ts` defines the others, and `operations.ts`
 * registers them with {@link registerRelocateOperations}.
 *
 * `operations.ts` imports this file, and this file uses that one's error classes and position
 * reader. So that either can be loaded first, nothing here runs while the file loads: every
 * helper is a function declaration, and the definitions are made when `operations.ts` asks.
 */

import { deepEqual, formatPath, isJsonObject, isPathPrefix, parsePath, type DocNode, type JsonObject, type JsonValue, type PathSegment } from "@sous-io/sous-lib-documents";
import { matchesFields } from "./checks.js";
import { EditNotPossible, OperationParamsError, type AliasDefinition, type ImpliedCheck, type OperationContext, type OperationDefinition } from "./operations.js";

/** The chain methods of these operations; `ValueOperations` in `chain.ts` extends this. */
export interface RelocateOperations<R> {
    /** The value at `to` is a copy of this one. With `ifMissing: true`, only a missing `to` is filled. */
    copy(to: string, options?: { ifMissing?: boolean }): R;
    /** This value moves to `to`. With `ifMissing: true`, it moves only when `to` is missing. */
    move(to: string, options?: { ifMissing?: boolean }): R;
    /** Adds the item just before the first item matching `where` (an action). */
    insertBeforeWhere(where: object, item: unknown): R;
    /** Adds the item just after the first item matching `where` (an action). */
    insertAfterWhere(where: object, item: unknown): R;
}

// ---------------------------------------------------------------------------------------------
// Helpers (function declarations only: see the note at the top)
// ---------------------------------------------------------------------------------------------

/** The parameters every operation has, besides its own. */
function commonParams(): string[] {
    return ["path", "assertion"];
}

/** Builds a definition, checking its parameters the way `define` in `operations.ts` does. */
function definition(spec: Omit<OperationDefinition, "normalize"> & { normalize?: (raw: JsonObject) => JsonObject }): OperationDefinition {
    const allowed = new Set([...commonParams(), ...spec.params]);

    return {
        ...spec,
        normalize(raw) {
            for (const key of Object.keys(raw)) {
                if (!allowed.has(key)) {
                    throw new OperationParamsError(`'${spec.name}' has no parameter '${key}'. Its parameters: ${["path", ...spec.params].join(", ")}.`);
                }
            }

            if (raw.assertion !== undefined && raw.assertion !== "none") {
                throw new OperationParamsError(`'${spec.name}': 'assertion' can only be "none".`);
            }

            checkPathParam(raw, "path", spec.name);

            return spec.normalize ? spec.normalize(raw) : raw;
        },
    };
}

/** Checks a parameter that is a path. A `${var}` in it is checked once substituted. */
function checkPathParam(raw: JsonObject, key: string, operation: string): void {
    const value = raw[key];

    if (value === undefined || value === null) {
        return;
    }

    if (typeof value !== "string") {
        throw new OperationParamsError(`'${operation}': '${key}' must be a string.`);
    }

    if (value.includes("${")) {
        return;
    }

    try {
        parsePath(value);
    } catch (error) {
        throw new OperationParamsError(`'${operation}': ${error instanceof Error ? error.message : String(error)}`);
    }
}

function requireKey(raw: JsonObject, key: string, operation: string): JsonValue {
    if (raw[key] === undefined) {
        throw new OperationParamsError(`'${operation}' needs '${key}'.`);
    }

    return raw[key]!;
}

function fieldsParam(raw: JsonObject, key: string, operation: string): JsonObject {
    const value = requireKey(raw, key, operation);

    if (!isJsonObject(value)) {
        throw new OperationParamsError(`'${operation}': '${key}' must be an object of fields to match.`);
    }

    return value;
}

function booleanParam(raw: JsonObject, key: string, operation: string): void {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") {
        throw new OperationParamsError(`'${operation}': '${key}' must be true or false.`);
    }
}

/** A list from `items`, or `item`. */
function itemsOf(raw: JsonObject, operation: string): JsonValue[] {
    if (raw.items !== undefined) {
        return Array.isArray(raw.items) ? [...raw.items] : [raw.items];
    }

    if (raw.item !== undefined) {
        return [raw.item];
    }

    throw new OperationParamsError(`'${operation}' needs 'items' (or 'item').`);
}

function without(raw: JsonObject, ...keys: string[]): JsonObject {
    return Object.fromEntries(Object.entries(raw).filter(([key]) => !keys.includes(key)));
}

function listOf(node: DocNode): JsonValue[] {
    const value = node.get();

    return Array.isArray(value) ? value : [];
}

function notAList(operation: string, node: DocNode): EditNotPossible {
    return new EditNotPossible(`'${operation}' needs a list at ${node.pathString || "the root"}, and the value there is not one.`);
}

/** The node at another path of the same file. */
function nodeAt(ctx: OperationContext, path: string): DocNode {
    return ctx.session.document().atPath(path);
}

/** Whether a record says the operation changed something. */
function acted(record: JsonValue | undefined): boolean {
    return isJsonObject(record) && (record.changed === true || record.moved === true);
}

/** The earlier record when it changed something, so a rollback goes back to before Sous first acted. */
function keepEarlier(previous: JsonValue, next: JsonValue): JsonValue {
    return acted(previous) ? previous : next;
}

// ---------------------------------------------------------------------------------------------
// copy and move
// ---------------------------------------------------------------------------------------------

/**
 * Checks `to`: a path that is not the root and does not overlap `path` (neither holds the other),
 * since copying or moving a value into itself, or over the object that holds it, has no meaning.
 */
function normalizeDestination(raw: JsonObject, operation: string): JsonObject {
    const to = requireKey(raw, "to", operation);

    if (typeof to !== "string" || to === "") {
        throw new OperationParamsError(`'${operation}' needs 'to', the path to ${operation} the value to.`);
    }

    checkPathParam(raw, "to", operation);
    booleanParam(raw, "ifMissing", operation);

    const from = typeof raw.path === "string" ? raw.path : "";

    if (from === "") {
        throw new OperationParamsError(`'${operation}' needs the 'path' of the value to ${operation}; the whole document cannot be ${operation === "copy" ? "copied" : "moved"} into itself.`);
    }

    if (!from.includes("${") && !to.includes("${")) {
        const a = parsePath(from);
        const b = parsePath(to);

        if (isPathPrefix(a, b) || isPathPrefix(b, a)) {
            throw new OperationParamsError(`'${operation}': 'to' (${to}) and 'path' (${from}) overlap; one holds the other.`);
        }

        // An item taken out of a list by its index is a different item on the next build, once the
        // items after it have moved up: the move would take one item after another.
        if (operation === "move" && typeof a.at(-1) === "number") {
            throw new OperationParamsError(`'move' moves the value at a key, and ${from} is a list item; use 'moveItem' to move an item within its list.`);
        }
    }

    return raw;
}

/** The value at `to`, changed: a record of whether it existed and what it was. */
function setRecorded(node: DocNode, value: JsonValue): JsonObject {
    const existed = node.exists();
    const current = node.get();

    if (existed && deepEqual(current, value)) {
        return { changed: false };
    }

    node.set(value);

    return existed ? { changed: true, existed: true, previous: current! } : { changed: true, existed: false };
}

/** Puts back what {@link setRecorded} changed. */
function restoreRecorded(node: DocNode, record: JsonObject): void {
    if (record.existed === true) {
        node.set(record.previous ?? null);
    } else if (node.exists()) {
        node.delete();
    }
}

/**
 * A `to` that names a list item must name one that is there: the value replaces it. (Adding to a
 * list is `ensureIncludes`'s job.)
 */
function checkItemTarget(operation: string, target: DocNode): void {
    const index = target.path[target.path.length - 1];

    if (typeof index === "number" && !target.exists()) {
        throw new EditNotPossible(`'${operation}' cannot put a value at ${target.pathString}: there is no item ${index} there to replace.`);
    }
}

function copyDefinition(): OperationDefinition {
    return definition({
        name: "copy",
        order: 20,
        scope: "document",
        summary:
            "The value at `to` is a copy of the value at `path`; what `to` held is recorded and restored on a rollback. Nothing happens while `path` is missing. With `ifMissing: true`, only a missing `to` is filled.",
        params: ["to", "ifMissing"],
        args: ["to"],
        normalize: (raw) => normalizeDestination(raw, "copy"),
        up(ctx, params) {
            const source = ctx.node();

            if (!source.exists()) {
                return { changed: false };
            }

            const target = nodeAt(ctx, params.to as string);

            if (params.ifMissing === true && target.exists()) {
                return { changed: false };
            }

            checkItemTarget("copy", target);

            return setRecorded(target, source.get()!);
        },
        down(ctx, params, record) {
            if (acted(record)) {
                restoreRecorded(nodeAt(ctx, params.to as string), record as JsonObject);
            }
        },
        mergeRecords: keepEarlier,
        // No automatic assertion: the value copied is only known when the file is read, and a
        // missing `path` (nothing to copy) is not an error.
        assertions: () => [],
    });
}

/** The parent path and the key of a path that ends in a key, or `undefined` when it ends in an index. */
function splitKey(path: string): { parent: PathSegment[]; key: string } | undefined {
    const segments = parsePath(path);
    const last = segments[segments.length - 1];

    return typeof last === "string" ? { parent: segments.slice(0, -1), key: last } : undefined;
}

/** Whether a move is a rename: both paths end in keys of the same object. */
function sameObject(ctx: OperationContext, from: string, to: string): { fromKey: string; toKey: string } | undefined {
    const a = splitKey(from);
    const b = splitKey(to);

    if (a === undefined || b === undefined || formatPath(a.parent) !== formatPath(b.parent)) {
        return undefined;
    }

    return isJsonObject(ctx.session.document().atPath(a.parent).get()) ? { fromKey: a.key, toKey: b.key } : undefined;
}

/** Where a key sits, so a rollback can put it back there: the key just before it, or `first`. */
function placeOf(node: DocNode): JsonObject {
    const keys = node.parent().keys();
    const at = keys.indexOf(node.path[node.path.length - 1] as string);

    return at <= 0 ? { first: true } : { after: keys[at - 1]! };
}

/** Puts a moved value back at its key, in the place {@link placeOf} recorded. */
function putBack(node: DocNode, record: JsonObject): void {
    const value = record.value ?? null;
    const last = node.path[node.path.length - 1] as string;
    const parent = node.parent();
    const existed = node.exists();

    node.set(value);

    if (existed) {
        return;
    }

    if (record.first === true) {
        parent.moveKeyFirst(last);
    } else if (typeof record.after === "string") {
        parent.moveKeyAfter(last, record.after);
    }
}

function moveDefinition(): OperationDefinition {
    return definition({
        name: "move",
        order: 20,
        scope: "document",
        summary:
            "The value at `path` moves to `to`, replacing what `to` held (recorded, and restored on a rollback). Within one object it is a rename, keeping the value's text, comments and place. Nothing happens while `path` is missing. With `ifMissing: true`, it moves only when `to` is missing.",
        params: ["to", "ifMissing"],
        args: ["to"],
        normalize: (raw) => normalizeDestination(raw, "move"),
        up(ctx, params) {
            const source = ctx.node();

            if (!source.exists()) {
                return { moved: false };
            }

            const to = params.to as string;
            const target = nodeAt(ctx, to);
            const existed = target.exists();

            if (params.ifMissing === true && existed) {
                return { moved: false };
            }

            const value = source.get()!;
            const replaced: JsonObject = existed ? { existed: true, previous: target.get()! } : { existed: false };
            const rename = sameObject(ctx, ctx.path, to);

            if (rename !== undefined) {
                // The library renames the key in place: its text, its comments and its place stay,
                // and a key already called `toKey` is removed.
                source.rename(rename.toKey);

                return { moved: true, renamed: true, ...replaced };
            }

            checkItemTarget("move", target);

            const place = placeOf(source);

            source.delete();
            target.set(value);

            return { moved: true, value, ...place, ...replaced };
        },
        down(ctx, params, record) {
            if (!acted(record)) return;

            const entry = record as JsonObject;
            const source = ctx.node();
            const target = nodeAt(ctx, params.to as string);

            if (entry.renamed === true) {
                const key = splitKey(ctx.path)!.key;

                if (target.exists() && !source.exists()) {
                    target.rename(key);
                }
            } else {
                putBack(source, entry);
            }

            restoreRecorded(target, entry);
        },
        mergeRecords: keepEarlier,
        assertions: (params, path) => (params.ifMissing === true ? [] : [{ check: "exists", arg: false, path }]),
    });
}

// ---------------------------------------------------------------------------------------------
// insertBeforeWhere and insertAfterWhere
// ---------------------------------------------------------------------------------------------

function insertWhereDefinition(name: "insertBeforeWhere" | "insertAfterWhere"): OperationDefinition {
    const before = name === "insertBeforeWhere";
    const side = before ? "before" : "after";

    return definition({
        name,
        order: 40,
        scope: "document",
        action: true,
        summary: `Adds the items just ${side} the first item matching \`where\`, or at the end when no item matches, even if they are already there (an action: Sous does it once, when the entry is first applied). A missing list is created.`,
        params: ["where", "items", "item"],
        args: ["where", "item"],
        normalize(raw) {
            fieldsParam(raw, "where", name);

            return { ...without(raw, "item"), items: itemsOf(raw, name) };
        },
        up(ctx, params) {
            const node = ctx.node();
            const value = node.get();

            if (value !== undefined && !Array.isArray(value)) {
                throw notAList(name, node);
            }

            if (value === undefined) {
                node.set([]);
            }

            const list = listOf(node);
            const at = list.findIndex((item) => matchesFields(item, params.where!));
            let index = at === -1 ? list.length : before ? at : at + 1;
            const added: JsonObject[] = [];

            for (const item of params.items as JsonValue[]) {
                node.insertAt(index, item);
                added.push({ item, index });
                index += 1;
            }

            return { added, matched: at !== -1, ...(value === undefined ? { created: true } : {}) };
        },
        down(ctx, _params, record) {
            if (!isJsonObject(record)) return;

            const node = ctx.node();

            // Last added first, each at the index it was added at, or else the last equal item.
            for (const entry of [...((record.added as JsonObject[] | undefined) ?? [])].reverse()) {
                const list = listOf(node);
                const at = entry.index as number;
                let index = deepEqual(list[at], entry.item) ? at : -1;

                for (let i = list.length - 1; index === -1 && i >= 0; i--) {
                    if (deepEqual(list[i], entry.item)) index = i;
                }

                if (index !== -1) node.removeAt(index);
            }

            if (record.created === true && Array.isArray(node.get()) && listOf(node).length === 0) {
                node.delete();
            }
        },
        assertions: (params, path) => (params.items as JsonValue[]).map((item): ImpliedCheck => ({ check: "includes", arg: item, path })),
    });
}

// ---------------------------------------------------------------------------------------------
// Registering
// ---------------------------------------------------------------------------------------------

/**
 * Adds these operations and their shorthand to the lists `operations.ts` builds its lookup from.
 *
 * ```ts
 * registerRelocateOperations(definitions, aliases);
 * ```
 */
export function registerRelocateOperations(definitions: OperationDefinition[], _aliases: AliasDefinition[]): void {
    definitions.push(
        copyDefinition(),
        moveDefinition(),
        insertWhereDefinition("insertBeforeWhere"),
        insertWhereDefinition("insertAfterWhere"),
    );
}
