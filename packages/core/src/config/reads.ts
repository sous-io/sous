import { createHash } from "node:crypto";
import { deepEqual, getAtPath } from "@sous-io/documents";
import type { JsonValue, PathSegment } from "@sous-io/plugin-api";
import type { EntitySnapshot, StoredEntity } from "../entities/entity-registry.js";

/**
 * What a contributor read while it ran (S2, "The Builder", rule 4): each config key with the value
 * it saw, and each entity list or entity with which entries existed (their ids, sources and a hash
 * of their contents), so an entity that appears, disappears or changes re-runs its readers.
 */
export type Read =
    | { readonly kind: "key"; readonly path: readonly PathSegment[]; readonly value: JsonValue | undefined }
    | { readonly kind: "entities"; readonly entityKind: string; readonly entries: readonly string[] }
    | { readonly kind: "entity"; readonly entityKind: string; readonly id: string; readonly entry: string | undefined };

/** What a contributor sees: the config and the entities, made from every other contributor's patches. */
export interface View {
    readonly config: JsonValue;
    readonly entities: EntitySnapshot;
}

/** One way a read changed: what it saw, and what it would see now. */
export interface ReadChange {
    readonly read: Read;
    readonly before: unknown;
    readonly after: unknown;
}

/**
 * The signature of an entity in a read: its id, where it came from, and a hash of its fields that
 * are not functions, so a changed entity with the same id reads differently.
 */
export function entitySignature(entity: StoredEntity): string {
    return `${entity.id} (${entity.contributor ?? entity.plugin}) ${entityContentHash(entity.entry)}`;
}

const contentHashes = new WeakMap<object, string>();

/**
 * A short hash of an entity entry's data: every field that is not a function, keys sorted. Methods
 * are left out, since they never compare equal across runs. Kept per entry object.
 *
 * ```ts
 * entityContentHash({ id: "codex", path: ".codex" }) === entityContentHash({ path: ".codex", id: "codex", run() {} });   // true
 * ```
 */
export function entityContentHash(entry: unknown): string {
    if (typeof entry !== "object" || entry === null) {
        return hashText(String(entry));
    }

    let hash = contentHashes.get(entry);

    if (hash === undefined) {
        hash = hashText(dataText(entry, new Set()));
        contentHashes.set(entry, hash);
    }

    return hash;
}

function hashText(text: string): string {
    return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

/** A stable text of a value's data, skipping functions; cycles and very deep values are cut short. */
function dataText(value: unknown, seen: Set<object>, depth = 0): string {
    if (typeof value === "function" || value === undefined) {
        return "";
    }

    if (typeof value === "bigint" || typeof value === "symbol") {
        return value.toString();
    }

    if (typeof value !== "object" || value === null) {
        return JSON.stringify(value);
    }

    if (seen.has(value) || depth > 32) {
        return "[cycle]";
    }

    seen.add(value);

    try {
        if (Array.isArray(value)) {
            return `[${value.map((item) => dataText(item, seen, depth + 1)).join(",")}]`;
        }

        if (value instanceof Map) {
            return `Map${dataText([...value.entries()], seen, depth + 1)}`;
        }

        if (value instanceof Set) {
            return `Set${dataText([...value.values()], seen, depth + 1)}`;
        }

        const toJson = (value as { toJSON?: unknown }).toJSON;

        if (typeof toJson === "function") {
            return dataText(toJson.call(value), seen, depth + 1);
        }

        const parts: string[] = [];

        for (const key of Object.keys(value).sort()) {
            const text = dataText((value as Record<string, unknown>)[key], seen, depth + 1);

            if (text !== "") {
                parts.push(`${JSON.stringify(key)}:${text}`);
            }
        }

        return `{${parts.join(",")}}`;
    } finally {
        seen.delete(value);
    }
}

/** The first read that would see something different in a view, or `undefined` when none would. */
export function firstChangedRead(reads: readonly Read[], view: View): ReadChange | undefined {
    for (const read of reads) {
        const change = changeOf(read, view);

        if (change) {
            return change;
        }
    }

    return undefined;
}

/** Every read that would see something different in a view. */
export function changedReads(reads: readonly Read[], view: View): ReadChange[] {
    return reads.map((read) => changeOf(read, view)).filter((change): change is ReadChange => change !== undefined);
}

function changeOf(read: Read, view: View): ReadChange | undefined {
    switch (read.kind) {
        case "key": {
            const now = getAtPath(view.config, read.path);

            return deepEqual(now, read.value) ? undefined : { read, before: read.value, after: now };
        }
        case "entities": {
            const now = view.entities.records(read.entityKind).map(entitySignature);

            return sameList(now, read.entries) ? undefined : { read, before: read.entries, after: now };
        }
        case "entity": {
            const found = view.entities.records(read.entityKind).find((entity) => entity.id === read.id);
            const now = found ? entitySignature(found) : undefined;

            return now === read.entry ? undefined : { read, before: read.entry, after: now };
        }
    }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((item, index) => item === b[index]);
}
