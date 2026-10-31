/**
 * Resolving one `_vars` block over the scope it inherits, its values referring to each other in any
 * order.
 */

import path from "node:path";
import { ConfigError } from "@sous-io/plugin-api";
import { isAutoVariable } from "./auto.js";
import { references, substitute } from "./substitute.js";
import type { VarScope } from "./types.js";

/** How to resolve a block. */
export interface ResolveBlockOptions {
    /**
     * Leaves out entries that cannot resolve, and ignores auto-variable names, instead of throwing.
     * Used while the config is built, when a value may only be known in a later pass.
     */
    partial?: boolean;
}

/** What resolving a block gave. */
export interface ResolvedBlock {
    /** The inherited scope with every resolved entry laid over it. */
    readonly scope: Record<string, string>;
    /** The block's entries that resolved. */
    readonly resolved: readonly string[];
    /** The block's entries left out (only with `partial`). */
    readonly pending: readonly string[];
}

/**
 * Resolves a `_vars` block over an inherited scope, as a fixpoint: each round substitutes every
 * entry still unresolved against the scope so far, and an entry whose references all resolve joins
 * the scope. Rounds repeat until one adds nothing, so `{ file: "${root}/x", root: "/data" }`
 * resolves as readily as the reverse.
 *
 * Throws a `ConfigError` when an entry never resolves (a cycle, or a name defined nowhere), and when
 * the block sets a variable sous sets itself. `context` names the block in errors.
 *
 * ```ts
 * resolveBlock({ file: "${root}/AGENTS.md", root: "${projectRoot}/docs" }, { projectRoot: "/p" }, "_vars").scope;
 * // { projectRoot: "/p", root: "/p/docs", file: "/p/docs/AGENTS.md" }
 * ```
 */
export function resolveBlock(
    block: Readonly<Record<string, unknown>>,
    inherited: VarScope,
    context: string,
    options: ResolveBlockOptions = {},
): ResolvedBlock {
    const entries = new Map<string, string>();

    for (const [key, value] of Object.entries(block)) {
        if (value === undefined || value === null) {
            continue;
        }

        if (isAutoVariable(key)) {
            if (options.partial || restatesAutoVariable(key, value, inherited)) {
                continue;
            }

            throw autoVariableError(key, context);
        }

        entries.set(key, typeof value === "string" ? value : String(value));
    }

    const scope: Record<string, string> = { ...inherited };
    const waiting = new Set(entries.keys());
    const resolved: string[] = [];
    let progressed = true;

    while (progressed && waiting.size > 0) {
        progressed = false;

        for (const key of waiting) {
            const substituted = substitute(entries.get(key)!, scope);

            if (references(substituted).length === 0) {
                scope[key] = substituted;
                waiting.delete(key);
                resolved.push(key);
                progressed = true;
            }
        }
    }

    if (waiting.size > 0 && !options.partial) {
        throw unresolvedBlockError(entries, scope, waiting, context);
    }

    return { scope, resolved, pending: [...waiting] };
}

/**
 * Whether a block's entry for an auto-variable only says again what sous sets, such as
 * `projectRoot: "${sousDir}/.."`, which every config written before `projectRoot` became an
 * auto-variable holds. Such an entry is accepted and ignored.
 */
function restatesAutoVariable(name: string, value: unknown, inherited: VarScope): boolean {
    const own = inherited[name];

    if (own === undefined || typeof value !== "string") {
        return false;
    }

    const written = substitute(value, inherited);

    return written === own || (references(written).length === 0 && path.resolve(written) === path.resolve(own));
}

/** The error for a block that sets a variable sous sets itself. */
export function autoVariableError(name: string, context: string): ConfigError {
    return new ConfigError(`${context} sets "${name}", which sous sets itself.`, {
        details: [`Remove "${name}" from ${context}; \${${name}} always holds the value sous gives it.`],
    });
}

/**
 * The error for entries that never resolved. It names each one and what it still needs, then
 * separates reference cycles from names defined nowhere, and lists what is in scope, so a typo is
 * obvious at a glance.
 */
function unresolvedBlockError(
    entries: ReadonlyMap<string, string>,
    scope: VarScope,
    waiting: ReadonlySet<string>,
    context: string,
): ConfigError {
    const needs = new Map<string, string[]>();

    for (const key of waiting) {
        needs.set(key, references(substitute(entries.get(key)!, scope)));
    }

    const edges = new Map<string, string[]>();

    for (const key of waiting) {
        edges.set(key, needs.get(key)!.filter((name) => waiting.has(name)));
    }

    const cycles = findCycles([...waiting], edges);
    const undefinedRefs = new Map<string, Set<string>>();

    for (const key of waiting) {
        for (const name of needs.get(key)!) {
            if (!waiting.has(name)) {
                const referrers = undefinedRefs.get(name) ?? new Set<string>();

                referrers.add(key);
                undefinedRefs.set(name, referrers);
            }
        }
    }

    const details: string[] = [];

    for (const key of [...waiting].sort()) {
        const names = needs.get(key)!.map((name) => `\${${name}}`).join(", ");

        details.push(`- ${key} still needs ${names || "(nothing resolvable)"}`);
    }

    if (cycles.length > 0) {
        details.push("", "Reference cycles (these variables reference each other):");

        for (const cycle of cycles) {
            const sorted = [...cycle].sort();

            details.push(`- ${[...sorted, sorted[0]].join(" -> ")}`);
        }
    }

    if (undefinedRefs.size > 0) {
        details.push("", "Undefined references (names defined nowhere: no _vars, _env, or auto-variable):");

        for (const name of [...undefinedRefs.keys()].sort()) {
            details.push(`- \${${name}} (needed by ${[...undefinedRefs.get(name)!].sort().join(", ")})`);
        }
    }

    const inScope = Object.keys(scope).sort();

    details.push("", `Variables in scope here: ${inScope.length > 0 ? inScope.join(", ") : "(none)"}`);

    return new ConfigError(`Unresolved variables in ${context}:`, { details });
}

/**
 * Reference cycles in a directed graph, by Tarjan's strongly connected components: a component of
 * more than one member, or a single member that refers to itself.
 */
function findCycles(nodes: readonly string[], edges: ReadonlyMap<string, readonly string[]>): string[][] {
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const components: string[][] = [];
    let counter = 0;

    const connect = (node: string): void => {
        index.set(node, counter);
        low.set(node, counter);
        counter++;
        stack.push(node);
        onStack.add(node);

        for (const next of edges.get(node) ?? []) {
            if (!index.has(next)) {
                connect(next);
                low.set(node, Math.min(low.get(node)!, low.get(next)!));
            } else if (onStack.has(next)) {
                low.set(node, Math.min(low.get(node)!, index.get(next)!));
            }
        }

        if (low.get(node) === index.get(node)) {
            const component: string[] = [];
            let member: string;

            do {
                member = stack.pop()!;
                onStack.delete(member);
                component.push(member);
            } while (member !== node);

            components.push(component);
        }
    };

    for (const node of nodes) {
        if (!index.has(node)) {
            connect(node);
        }
    }

    return components.filter((component) => component.length > 1 || (edges.get(component[0]!) ?? []).includes(component[0]!));
}
