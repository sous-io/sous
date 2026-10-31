import type { ResolvedReferenceFacts, VariableEntry } from "@sous-io/plugin-api";
import { BLANK, Layout } from "../terminal/layout.js";
import type { Style } from "./style.js";

/**
 * What a reference resolved to, and why (ported from the CLI's `src/services/ref-resolver/ref-report.ts`):
 * the facts lined up, a blank line, then the reason.
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
    const layout = new Layout(style, columns);
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

    return [...layout.variableLines(entries), BLANK, ...layout.paragraphLines(reason, { indent: 2, width: layout.wrapWidth - 2, hangingIndent: 0 })];
}
