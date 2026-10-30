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
    /** For each contributor id, the ids its `before` and `after` declarations put ahead of it. */
    readonly predecessors: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The pattern that means "every other contributor" in `before` and `after`. */
export const EVERY_CONTRIBUTOR = "*";

/**
 * Orders contributors by name (bytewise), adjusted by their `before` and `after` declarations. A name in either list matches a contributor id or a plugin name, exactly or
 * as a wildcard. When declarations form a cycle, the cycle is broken by name order and reported.
 *
 * A bare `"*"` means every contributor that does not itself declare `"*"` on the same side:
 * `after: ["*"]` puts a contributor after all of those (the user's files use it to land last), and
 * `before: ["*"]` before all of them. A contributor that names it explicitly the other way round
 * (`after: ["confd/*"]` beside a file's `after: ["*"]`) keeps its own declaration. Among the
 * contributors that declare `"*"`, their other declarations and names decide.
 *
 * ```ts
 * sortContributors([
 *     { id: "b", plugin: "p", before: [], after: [] },
 *     { id: "a", plugin: "p", before: [], after: ["b"] },
 * ]).order.map((c) => c.id);   // ["b", "a"]
 *
 * sortContributors([
 *     { id: "file", plugin: "files", before: [], after: ["*"] },
 *     { id: "z-plugin", plugin: "p", before: [], after: [] },
 * ]).order.map((c) => c.id);   // ["z-plugin", "file"]
 * ```
 */
export function sortContributors<T extends Orderable>(items: readonly T[]): OrderResult<T> {
    const sorted = [...items].sort((a, b) => compareNames(a.id, b.id));
    const incoming = new Map<T, Set<T>>(sorted.map((item) => [item, new Set<T>()]));

    for (const item of sorted) {
        for (const pattern of item.after) {
            if (pattern === EVERY_CONTRIBUTOR) {
                continue;
            }

            for (const other of matching(sorted, pattern, item)) {
                incoming.get(item)!.add(other);
            }
        }

        for (const pattern of item.before) {
            if (pattern === EVERY_CONTRIBUTOR) {
                continue;
            }

            for (const other of matching(sorted, pattern, item)) {
                incoming.get(other)!.add(item);
            }
        }
    }

    addEveryContributorEdges(sorted, incoming);

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

    const predecessors = new Map<string, Set<string>>();

    for (const [item, deps] of incoming) {
        predecessors.set(item.id, new Set([...deps].map((dep) => dep.id)));
    }

    return { order, cycle, predecessors };
}

/**
 * Adds the edges of `after: ["*"]` and `before: ["*"]`: for `after`, every contributor that does not
 * declare `after: ["*"]` itself comes first, unless the explicit declarations already put it after
 * this one (directly or through others); `before` is the mirror image.
 */
function addEveryContributorEdges<T extends Orderable>(sorted: readonly T[], incoming: Map<T, Set<T>>): void {
    const explicit = new Map<T, Set<T>>([...incoming].map(([item, deps]) => [item, new Set(deps)]));
    const lastGroup = sorted.filter((item) => item.after.includes(EVERY_CONTRIBUTOR));
    const firstGroup = sorted.filter((item) => item.before.includes(EVERY_CONTRIBUTOR));

    for (const item of lastGroup) {
        const later = reachable(item, sorted, (other) => explicit.get(other)!);

        for (const other of sorted) {
            if (other !== item && !lastGroup.includes(other) && !later.has(other)) {
                incoming.get(item)!.add(other);
            }
        }
    }

    for (const item of firstGroup) {
        const earlier = reachable(item, sorted, (other) => dependentsOf(other, sorted, explicit));

        for (const other of sorted) {
            if (other !== item && !firstGroup.includes(other) && !earlier.has(other)) {
                incoming.get(other)!.add(item);
            }
        }
    }
}

/**
 * Every contributor that must come after `start` by the explicit declarations, found by walking
 * from each contributor to `start` through `edges` (the contributors it must follow).
 */
function reachable<T>(start: T, items: readonly T[], edges: (item: T) => ReadonlySet<T>): Set<T> {
    const result = new Set<T>();

    for (const item of items) {
        if (item !== start && leadsTo(item, start, edges, new Set())) {
            result.add(item);
        }
    }

    return result;
}

function leadsTo<T>(from: T, target: T, edges: (item: T) => ReadonlySet<T>, seen: Set<T>): boolean {
    for (const next of edges(from)) {
        if (next === target) {
            return true;
        }

        if (!seen.has(next)) {
            seen.add(next);

            if (leadsTo(next, target, edges, seen)) {
                return true;
            }
        }
    }

    return false;
}

function dependentsOf<T>(item: T, items: readonly T[], explicit: ReadonlyMap<T, ReadonlySet<T>>): Set<T> {
    return new Set(items.filter((other) => explicit.get(other)!.has(item)));
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
