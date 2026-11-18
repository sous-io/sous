/**
 * The merge of the per-harness config builds into the one config every intent reads.
 *
 * One rule: a list entry that belongs to one harness is taken from that harness's build. Everything
 * else stays as the build with no harness has it. The lists this applies to are `harness-list`
 * entities (`compilation.targets[].outputs`, `editor.edits`, `recipes.contents`, and any a plugin
 * adds).
 *
 * In a harness's build, an entry of such a list belongs to that harness when it is marked with it
 * (`harness: "codex"`), or when it is not marked at all and the build with no harness does not hold
 * it (it exists only because of the harness, through a condition on `harness.id`). Such an entry is
 * added to the merged list marked with the harness. An entry of the build with no harness that is
 * marked with a harness which had its own build is replaced by that build's entries.
 *
 * ```text
 * no harness:  outputs [ {dir: a}, {dir: .claude/skills, harness: claude}, {dir: .codex/skills, harness: codex} ]
 * claude:      outputs [ {dir: a}, {dir: .claude/skills, harness: claude, _vars: {tool: Claude}}, ... ]
 * codex:       outputs [ {dir: a}, ..., {dir: .codex/skills, harness: codex, _vars: {tool: Codex}} ]
 * merged:      outputs [ {dir: a}, the claude build's claude output, the codex build's codex output ]
 * ```
 */

import { stableStringify } from "@sous-io/sous-lib-documents";
import type { JsonObject, JsonValue, PathSegment } from "@sous-io/sous-plugin-api";

/** The key an entry is marked with: `harness: "codex"`. */
export const HARNESS_MARK = "harness";

/** Stands for "every item of the array" in a list's path. */
export const EACH = Symbol("each item");

/** One segment of a list's path: a key, or every item of an array. */
export type ListSegment = string | typeof EACH;

/** The entity kind that names the lists the merge applies to. */
export const HARNESS_LIST_KIND = "harness-list";

/** A `harness-list` entity: a list whose entries may belong to one harness. */
export interface HarnessListEntity {
    /** Names it: `compilation.outputs`. */
    id: string;
    /** The list, with `[]` for every item of an array on the way: `compilation.targets[].outputs`. */
    path: string;
    description?: string;
}

/** The lists core declares itself, so the merge carries them whichever plugin fills them. */
export const CORE_HARNESS_LISTS: readonly HarnessListEntity[] = [
    {
        id: "compilation.outputs",
        path: "compilation.targets[].outputs",
        description: "The outputs of each compilation target. A target is matched between builds by its id, else by its place.",
    },
    { id: "editor.edits", path: "editor.edits", description: "The editor's list of document edits." },
    { id: "recipes.contents", path: "recipes.contents", description: "The contents groups of every active recipe." },
];

/**
 * Parses a list's path: `compilation.targets[].outputs` gives
 * `["compilation", "targets", EACH, "outputs"]`.
 */
export function parseListPath(path: string): ListSegment[] {
    const segments: ListSegment[] = [];

    for (const part of path.split(".")) {
        let name = part;
        let each = 0;

        while (name.endsWith("[]")) {
            name = name.slice(0, -2);
            each += 1;
        }

        if (name === "") {
            throw new Error(`The harness list path "${path}" has an empty key.`);
        }

        segments.push(name);

        for (let index = 0; index < each; index++) {
            segments.push(EACH);
        }
    }

    return segments;
}

/**
 * Whether a concrete path and a list's path name overlapping places: one is inside the other, or
 * they are the same. `EACH` matches any index.
 */
export function overlapsList(path: readonly PathSegment[], list: readonly ListSegment[]): boolean {
    const length = Math.min(path.length, list.length);

    for (let index = 0; index < length; index++) {
        const want = list[index]!;
        const have = path[index]!;

        if (want === EACH ? typeof have !== "number" : want !== have) {
            return false;
        }
    }

    return true;
}

/** The harness an entry is marked with, or `undefined`. */
export function markOf(entry: JsonValue | undefined): string | undefined {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return undefined;
    }

    const mark = entry[HARNESS_MARK];

    return typeof mark === "string" ? mark : undefined;
}

/**
 * The config every intent reads: `base` (the build with no harness), with every entry of every
 * list in `lists` that belongs to a harness taken from that harness's build in `builds`. Neither
 * input is changed. Harnesses are taken in id order, so the result never depends on which build
 * finished first.
 */
export function mergeHarnessBuilds(
    base: Readonly<JsonObject>,
    builds: ReadonlyMap<string, Readonly<JsonObject>>,
    lists: readonly (readonly ListSegment[])[],
): JsonObject {
    let merged = base as JsonValue;

    if (builds.size === 0) {
        return base as JsonObject;
    }

    const ids = [...builds.keys()].sort();

    for (const list of lists) {
        merged = mergeAt(
            merged,
            ids.map((id) => [id, builds.get(id) as JsonValue] as const),
            list,
            ids,
        ) ?? merged;
    }

    return merged as JsonObject;
}

type Others = ReadonlyArray<readonly [string, JsonValue | undefined]>;

/**
 * Follows a list's path down `node` and, beside it, down each harness's build, then merges the list.
 * Returns `undefined` when nothing changed, so untouched branches keep their identity.
 */
function mergeAt(node: JsonValue | undefined, others: Others, rest: readonly ListSegment[], built: readonly string[]): JsonValue | undefined {
    if (rest.length === 0) {
        return mergeList(node, others, built);
    }

    const [segment, ...tail] = rest;

    if (segment === EACH) {
        if (!Array.isArray(node)) {
            return undefined;
        }

        let changed = false;
        const items = node.map((item, index) => {
            const result = mergeAt(item, others.map(([id, other]) => [id, counterpart(item, index, other)] as const), tail, built);

            if (result === undefined) {
                return item;
            }

            changed = true;

            return result;
        });

        return changed ? items : undefined;
    }

    const own = isObject(node) ? node[segment!] : undefined;
    const result = mergeAt(own, others.map(([id, other]) => [id, isObject(other) ? other[segment!] : undefined] as const), tail, built);

    if (result === undefined) {
        return undefined;
    }

    return { ...(isObject(node) ? node : {}), [segment!]: result };
}

/**
 * The item of a harness's array that matches `item` of the base array: the one with the same `id`
 * when `item` has one, else the one in the same place.
 */
function counterpart(item: JsonValue, index: number, other: JsonValue | undefined): JsonValue | undefined {
    if (!Array.isArray(other)) {
        return undefined;
    }

    const id = isObject(item) && typeof item.id === "string" ? item.id : undefined;

    if (id !== undefined) {
        return other.find((candidate) => isObject(candidate) && candidate.id === id);
    }

    return other[index];
}

/**
 * Merges one list. The base's entries stay in place, except those marked with a harness that had a
 * build: the first of them is replaced by every entry that belongs to that harness in its build, and
 * the rest are dropped. Entries that belong to a harness none of the base's entries is marked with
 * go at the end, in harness id order.
 */
function mergeList(node: JsonValue | undefined, others: Others, built: readonly string[]): JsonValue | undefined {
    const base = Array.isArray(node) ? node : [];
    const owned = new Map<string, JsonValue[]>();

    for (const [id, other] of others) {
        if (Array.isArray(other)) {
            owned.set(id, ownedBy(id, base, other));
        }
    }

    const result: JsonValue[] = [];
    const placed = new Set<string>();
    let changed = false;

    for (const entry of base) {
        const mark = markOf(entry);

        if (mark === undefined || !built.includes(mark)) {
            result.push(entry);
            continue;
        }

        changed = true;

        if (!placed.has(mark)) {
            placed.add(mark);
            result.push(...(owned.get(mark) ?? []));
        }
    }

    for (const [id, entries] of owned) {
        if (!placed.has(id) && entries.length > 0) {
            changed = true;
            result.push(...entries);
        }
    }

    if (!changed) {
        return undefined;
    }

    return result;
}

/**
 * The entries of one harness's list that belong to it: those marked with it, and those not marked
 * that the base does not hold (counted, so a second copy of a base entry belongs to the harness).
 * An entry of the second kind is marked with the harness when it is an object.
 */
function ownedBy(id: string, base: readonly JsonValue[], other: readonly JsonValue[]): JsonValue[] {
    const remaining = new Map<string, number>();

    for (const entry of base) {
        if (markOf(entry) === undefined) {
            const key = stableStringify(entry);

            remaining.set(key, (remaining.get(key) ?? 0) + 1);
        }
    }

    const owned: JsonValue[] = [];

    for (const entry of other) {
        const mark = markOf(entry);

        if (mark === id) {
            owned.push(entry);
            continue;
        }

        if (mark !== undefined) {
            continue;
        }

        const key = stableStringify(entry);
        const left = remaining.get(key) ?? 0;

        if (left > 0) {
            remaining.set(key, left - 1);
            continue;
        }

        owned.push(isObject(entry) ? { ...entry, [HARNESS_MARK]: id } : entry);
    }

    return owned;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
