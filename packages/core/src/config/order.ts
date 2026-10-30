import { matchesWildcard } from "../util/names.js";

/** What ordering needs to know about a contributor. */
export interface Orderable {
    readonly id: string;
    readonly plugin: string;
    /** Its declared apply order, 0 to 99999: higher numbers apply later. */
    readonly applyOrder: number;
    readonly before: readonly string[];
    readonly after: readonly string[];
}

/** The result of ordering: the order, and any cycle found. */
export interface OrderResult<T> {
    /** The order patches apply in, sorted by {@link applyOrderKey}. */
    readonly order: T[];
    /** Contributors whose declarations could not all be met, because they form a cycle. */
    readonly cycle: string[];
    /** For each contributor id, the ids its `before` and `after` declarations put ahead of it. */
    readonly predecessors: ReadonlyMap<string, ReadonlySet<string>>;
    /** For each contributor id, its apply order once `before` and `after` are met. It may pass 99999. */
    readonly actualApplyOrder: ReadonlyMap<string, number>;
    /** One plain sentence per change from a declared apply order to the actual one. */
    readonly adjustments: string[];
}

/** The pattern that means "every other contributor" in `before` and `after`. */
export const EVERY_CONTRIBUTOR = "*";

/** The lowest and highest apply order a contributor may declare. */
export const MIN_APPLY_ORDER = 0;
export const MAX_APPLY_ORDER = 99999;

/**
 * The text patches are sorted by: the actual apply order padded to six digits, then the id. Six
 * digits leave room for an actual apply order pushed past 99999.
 *
 * ```ts
 * applyOrderKey(90000, "config-files.main");   // "090000config-files.main"
 * applyOrderKey(100000, "late");               // "100000late"
 * ```
 */
export function applyOrderKey(actualApplyOrder: number, id: string): string {
    return `${String(actualApplyOrder).padStart(6, "0")}${id}`;
}

/** Why one contributor must apply before another. */
interface Reason {
    readonly declarer: string;
    readonly side: "before" | "after";
    readonly pattern: string;
}

/**
 * Orders contributors by apply order, adjusted by their `before` and `after` declarations. A
 * name in either list matches a contributor id or a plugin name, exactly or as a wildcard.
 *
 * Each contributor declares an apply order (default 0); higher numbers apply later, and equal
 * numbers apply in id order (bytewise). When a number and a `before` or `after` disagree, `before`
 * and `after` win: a contributor declaring `after` moves to one past the contributor it must
 * follow, one declaring `before` to one less than the contributor it must precede (never less than 0),
 * and whatever must follow or precede a moved contributor moves with it. These actual apply orders
 * are not capped at 99999. When declarations form a cycle, the cycle is broken by name order and
 * reported.
 *
 * A bare `"*"` means every contributor that does not itself declare `"*"` on the same side:
 * `after: ["*"]` puts a contributor after all of those, and `before: ["*"]` before all of them. A
 * contributor that names one explicitly the other way round keeps its own declaration. Among the
 * contributors that declare `"*"`, their other declarations, numbers and names decide.
 *
 * ```ts
 * sortContributors([
 *     { id: "b", plugin: "p", applyOrder: 0, before: [], after: [] },
 *     { id: "a", plugin: "p", applyOrder: 0, before: [], after: [] },
 *     { id: "late", plugin: "p", applyOrder: 50, before: [], after: [] },
 * ]).order.map((c) => c.id);   // ["a", "b", "late"]
 *
 * sortContributors([
 *     { id: "fixups", plugin: "p", applyOrder: 0, before: [], after: ["late"] },
 *     { id: "late", plugin: "p", applyOrder: 50, before: [], after: [] },
 * ]).actualApplyOrder.get("fixups");   // 51
 * ```
 */
export function sortContributors<T extends Orderable>(items: readonly T[]): OrderResult<T> {
    const sorted = [...items].sort((a, b) => compareNames(a.id, b.id));
    const incoming = new Map<T, Map<T, Reason>>(sorted.map((item) => [item, new Map<T, Reason>()]));
    const addEdge = (from: T, to: T, reason: Reason): void => {
        if (!incoming.get(to)!.has(from)) {
            incoming.get(to)!.set(from, reason);
        }
    };

    for (const item of sorted) {
        for (const pattern of item.after) {
            if (pattern === EVERY_CONTRIBUTOR) {
                continue;
            }

            for (const other of matching(sorted, pattern, item)) {
                addEdge(other, item, { declarer: item.id, side: "after", pattern });
            }
        }

        for (const pattern of item.before) {
            if (pattern === EVERY_CONTRIBUTOR) {
                continue;
            }

            for (const other of matching(sorted, pattern, item)) {
                addEdge(item, other, { declarer: item.id, side: "before", pattern });
            }
        }
    }

    addEveryContributorEdges(sorted, incoming, addEdge);

    const topological: T[] = [];
    const placed = new Set<T>();
    const cycle: string[] = [];

    while (topological.length < sorted.length) {
        let next = sorted.find((item) => !placed.has(item) && [...incoming.get(item)!.keys()].every((dep) => placed.has(dep)));

        if (!next) {
            next = sorted.find((item) => !placed.has(item))!;
            cycle.push(next.id);
        }

        placed.add(next);
        topological.push(next);
    }

    const { actual, adjustments } = actualApplyOrders(topological, incoming);
    const order = [...sorted].sort((a, b) =>
        compareNames(applyOrderKey(actual.get(a)!, a.id), applyOrderKey(actual.get(b)!, b.id)),
    );
    const predecessors = new Map<string, Set<string>>();

    for (const [item, deps] of incoming) {
        predecessors.set(item.id, new Set([...deps.keys()].map((dep) => dep.id)));
    }

    return {
        order,
        cycle,
        predecessors,
        actualApplyOrder: new Map([...actual].map(([item, value]) => [item.id, value])),
        adjustments,
    };
}

/**
 * Works out each contributor's actual apply order from its declared one, so that every `before`
 * and `after` the topological order kept (a cycle drops one) is met.
 *
 * First, from last to first, a contributor that declares `before` and does not yet sort before
 * that contributor moves to one less than it (never less than 0), and so does anything that must
 * precede a contributor moved this way. Then, from first to last, a contributor that does not yet
 * sort after one it must follow moves to one past it. The second step fixes whatever the first
 * could not (a `before` held at 0) and carries every `after` along, so at the end every kept
 * declaration is met.
 */
function actualApplyOrders<T extends Orderable>(
    topological: readonly T[],
    incoming: ReadonlyMap<T, ReadonlyMap<T, Reason>>,
): { actual: Map<T, number>; adjustments: string[] } {
    const position = new Map(topological.map((item, index) => [item, index]));
    const actual = new Map(topological.map((item) => [item, item.applyOrder]));
    const adjustments: string[] = [];
    const key = (item: T): string => applyOrderKey(actual.get(item)!, item.id);
    const kept = (from: T, to: T): boolean => position.get(from)! < position.get(to)!;
    const outgoing = new Map<T, Array<[T, Reason]>>(topological.map((item) => [item, []]));

    for (const [to, deps] of incoming) {
        for (const [from, reason] of deps) {
            if (kept(from, to)) {
                outgoing.get(from)!.push([to, reason]);
            }
        }
    }

    const movedEarlier = new Set<T>();

    for (const item of [...topological].reverse()) {
        let target: [T, Reason] | undefined;

        for (const [next, reason] of outgoing.get(item)!) {
            const applies = (reason.side === "before" && reason.declarer === item.id) || movedEarlier.has(next);

            if (applies && key(item) >= key(next) && (target === undefined || actual.get(next)! < actual.get(target[0])!)) {
                target = [next, reason];
            }
        }

        if (target !== undefined) {
            const from = actual.get(item)!;
            const to = Math.max(MIN_APPLY_ORDER, actual.get(target[0])! - 1);

            if (to !== from) {
                actual.set(item, to);
                movedEarlier.add(item);
                adjustments.push(adjustment(item.id, from, to, "before", target[0].id, actual.get(target[0])!, target[1]));
            }
        }
    }

    for (const item of topological) {
        let target: [T, Reason] | undefined;

        for (const [previous, reason] of incoming.get(item)!) {
            if (kept(previous, item) && key(item) <= key(previous) && (target === undefined || actual.get(previous)! > actual.get(target[0])!)) {
                target = [previous, reason];
            }
        }

        if (target !== undefined) {
            const from = actual.get(item)!;
            const to = actual.get(target[0])! + 1;

            actual.set(item, to);
            adjustments.push(adjustment(item.id, from, to, "after", target[0].id, actual.get(target[0])!, target[1]));
        }
    }

    return { actual, adjustments };
}

/** `Apply order of "fixups" moves from 0 to 51, after "late" (50), because "fixups" declares after "late".` */
function adjustment(id: string, from: number, to: number, side: "before" | "after", other: string, otherOrder: number, reason: Reason): string {
    return `Apply order of "${id}" moves from ${from} to ${to}, ${side} "${other}" (${otherOrder}), because "${reason.declarer}" declares ${reason.side} "${reason.pattern}".`;
}

/**
 * Adds the edges of `after: ["*"]` and `before: ["*"]`: for `after`, every contributor that does not
 * declare `after: ["*"]` itself comes first, unless the explicit declarations already put it after
 * this one (directly or through others); `before` is the mirror image.
 */
function addEveryContributorEdges<T extends Orderable>(
    sorted: readonly T[],
    incoming: ReadonlyMap<T, ReadonlyMap<T, Reason>>,
    addEdge: (from: T, to: T, reason: Reason) => void,
): void {
    const explicit = new Map<T, Set<T>>([...incoming].map(([item, deps]) => [item, new Set(deps.keys())]));
    const lastGroup = sorted.filter((item) => item.after.includes(EVERY_CONTRIBUTOR));
    const firstGroup = sorted.filter((item) => item.before.includes(EVERY_CONTRIBUTOR));

    for (const item of lastGroup) {
        const later = reachable(item, sorted, (other) => explicit.get(other)!);

        for (const other of sorted) {
            if (other !== item && !lastGroup.includes(other) && !later.has(other)) {
                addEdge(other, item, { declarer: item.id, side: "after", pattern: EVERY_CONTRIBUTOR });
            }
        }
    }

    for (const item of firstGroup) {
        const earlier = reachable(item, sorted, (other) => dependentsOf(other, sorted, explicit));

        for (const other of sorted) {
            if (other !== item && !firstGroup.includes(other) && !earlier.has(other)) {
                addEdge(item, other, { declarer: item.id, side: "before", pattern: EVERY_CONTRIBUTOR });
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
