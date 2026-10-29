import { deepEqual, getAtPath } from "@sous-io/documents";
import type { JsonValue, PathSegment } from "@sous-io/plugin-api";
import type { EntitySnapshot, StoredEntity } from "../entities/entity-registry.js";

/**
 * What a contributor read while it ran (S2, "The Builder", rule 4): each config key with the value
 * it saw, and each entity list or entity with which entries existed (their ids and sources).
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

/** The signature of an entity in a read: its id and where it came from. */
export function entitySignature(entity: StoredEntity): string {
    return `${entity.id} (${entity.contributor ?? entity.plugin})`;
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
