import { matchesWildcard } from "../util/names.js";

/** What ordering needs to know about a contributor. */
export interface Orderable {
    readonly id: string;
    readonly plugin: string;
    readonly before: readonly string[];
    readonly after: readonly string[];
}

/** The result of ordering: the order, and any cycle found. */
export interface OrderResult<T> {
    readonly order: T[];
    /** Contributors whose declarations could not all be met, because they form a cycle. */
    readonly cycle: string[];
}

/**
 * Orders contributors by name (bytewise), adjusted by their `before` and `after` declarations (S2,
 * "Order and stages"). A name in either list matches a contributor id or a plugin name, exactly or
 * as a wildcard. When declarations form a cycle, the cycle is broken by name order and reported.
 *
 * ```ts
 * sortContributors([
 *     { id: "b", plugin: "p", before: [], after: [] },
 *     { id: "a", plugin: "p", before: [], after: ["b"] },
 * ]).order.map((c) => c.id);   // ["b", "a"]
 * ```
 */
export function sortContributors<T extends Orderable>(items: readonly T[]): OrderResult<T> {
    const sorted = [...items].sort((a, b) => compareNames(a.id, b.id));
    const incoming = new Map<T, Set<T>>(sorted.map((item) => [item, new Set<T>()]));

    for (const item of sorted) {
        for (const pattern of item.after) {
            for (const other of matching(sorted, pattern, item)) {
                incoming.get(item)!.add(other);
            }
        }

        for (const pattern of item.before) {
            for (const other of matching(sorted, pattern, item)) {
                incoming.get(other)!.add(item);
            }
        }
    }

    const order: T[] = [];
    const placed = new Set<T>();
    const cycle: string[] = [];

    while (order.length < sorted.length) {
        let next = sorted.find((item) => !placed.has(item) && [...incoming.get(item)!].every((dep) => placed.has(dep)));

        if (!next) {
            next = sorted.find((item) => !placed.has(item))!;
            cycle.push(next.id);
        }

        placed.add(next);
        order.push(next);
    }

    return { order, cycle };
}

function matching<T extends Orderable>(items: readonly T[], pattern: string, self: T): T[] {
    return items.filter(
        (item) => item !== self && (matchesWildcard(pattern, item.id) || matchesWildcard(pattern, item.plugin)),
    );
}

/** Bytewise comparison, so the order never depends on the machine's locale. */
export function compareNames(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}
