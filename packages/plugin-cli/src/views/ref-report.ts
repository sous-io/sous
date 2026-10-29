import { Printer, type VariableEntry } from "./printer.js";
import type { Style } from "./style.js";

/** The facts plugin-refs reports with a resolved reference (its `ResolvedRefFacts`). */
export interface ResolvedReferenceFacts {
    readonly search: string;
    readonly resolvedTo: string;
    readonly kind: string;
    readonly variable?: string;
    readonly recipe?: string;
    readonly namespace?: string;
    readonly repository?: string;
    readonly location?: string;
    readonly description?: string;
    readonly reason?: string;
}

/** Whether a message's details are a resolved reference's facts. */
export function isResolvedReference(details: unknown): details is ResolvedReferenceFacts {
    const facts = details as Partial<ResolvedReferenceFacts> | undefined;

    return typeof facts?.resolvedTo === "string" && typeof facts.search === "string" && typeof facts.kind === "string";
}

/**
 * What a reference resolved to, and why (ported from today's
 * `src/services/ref-resolver/ref-report.ts`): the facts lined up, a blank line, then the reason.
 *
 * ```text
 *     Resolved to: github.com/acme/recipes/workflow/git
 *     Namespace  : workflow
 *     Repository : acme
 *
 *   'git' named one recipe, and nothing else, so that is what is being used.
 * ```
 */
export function formatResolvedReference(facts: ResolvedReferenceFacts, reason: string, style: Style, columns = 100): string[] {
    const optional: Array<[string, string | undefined]> = [
        ["Variable", facts.variable],
        ["Recipe", facts.recipe],
        ["Namespace", facts.namespace],
        ["Repository", facts.repository],
        ["Location", facts.location],
        ["Description", facts.description],
    ];
    const entries: VariableEntry[] = [
        { label: "Resolved to", value: facts.resolvedTo },
        ...optional.filter((entry): entry is [string, string] => entry[1] !== undefined).map(([label, value]) => ({ label, value })),
    ];
    const out = new Printer(style, columns);

    out.variables(entries);
    out.log("");
    out.paragraph(reason, { indent: 2, width: out.wrapWidth - 2, hangingIndent: 0 });

    return out.lines;
}
