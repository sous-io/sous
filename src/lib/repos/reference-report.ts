/**
 * Saying what a reference resolved to.
 *
 * A word on the command line can name a repository, a namespace, a recipe or a
 * variable, and when sous settles which one it means it has to say so. What it
 * resolved to is a set of facts, so it is written as the same key and value
 * list every other set of facts in the CLI is written as, with one short
 * sentence after it saying why that candidate won. One function builds it, so
 * every command that resolves a reference reports it the same way; `pickReference`
 * in `src/lib/refs/pick.ts` is the single caller, which is how every command gets it.
 */

import {
  formatVariable,
  indent,
  wrapColumns,
  wrapText,
  type VariableEntry,
} from "../../utils/formatting.js";
import { SCOPE_LABELS, SousScope } from "../refs/scopes.js";
import type { ReferenceMatch } from "../refs/find.js";

/** What a resolved reference is, in the words the report shows. */
export interface ResolvedReferenceFacts {
  /** The reference exactly as the person wrote it. */
  search: string;
  /** The fully qualified spelling the run proceeds with. */
  resolvedTo: string;
  /** What kind of thing it turned out to be: "recipe", "namespace", "repository". */
  kind: string;
  /** The repository publishing it. */
  repository?: string;
  /** The namespace it lives in, when it has one. */
  namespace?: string;
  /** The recipe itself, when the reference named one. */
  recipe?: string;
  /** The variable itself, when the reference named one. */
  variable?: string;
  /** Where a repository lives, when the reference named a repository. */
  location?: string;
  /** The publisher's one-line summary, when there is one. */
  description?: string;
  /**
   * Why this candidate won, as the closing sentence. The default says the
   * reference named one thing and nothing else; a caller that settled it some
   * other way (taking the first of several, say) supplies its own.
   */
  reason?: string;
}

/**
 * The report as lines to write: the facts, a blank line, and the sentence.
 *
 * @param facts - What the reference resolved to.
 * @returns The lines to write, ready for the console.
 */
export function formatResolvedReference(facts: ResolvedReferenceFacts): string[] {
  const entries: VariableEntry[] = [
    { label: "Resolved to", value: facts.resolvedTo },
    ...(facts.variable === undefined ? [] : [{ label: "Variable", value: facts.variable }]),
    ...(facts.recipe === undefined ? [] : [{ label: "Recipe", value: facts.recipe }]),
    ...(facts.namespace === undefined ? [] : [{ label: "Namespace", value: facts.namespace }]),
    ...(facts.repository === undefined
      ? []
      : [{ label: "Repository", value: facts.repository }]),
    ...(facts.location === undefined ? [] : [{ label: "Location", value: facts.location }]),
    ...(facts.description === undefined
      ? []
      : [{ label: "Description", value: facts.description }]),
  ];

  const labelWidth = Math.max(...entries.map((entry) => entry.label.length));
  const lines = entries.flatMap((entry) => formatVariable(entry, { labelWidth }));

  const reason =
    facts.reason ??
    `'${facts.search}' named one ${facts.kind}, and nothing else, so that is what ` +
      `is being used.`;

  lines.push("");
  for (const line of wrapText(reason, wrapColumns() - 4)) {
    lines.push(indent(line));
  }

  return lines;
}

/**
 * The facts one match carries, ready for `formatResolvedReference`.
 *
 * The match knows what it is; this decides which of its fields are facts worth
 * showing. A repository's detail is where it lives rather than a summary of it,
 * and a repository's own name is already the resolved spelling, so neither is
 * repeated as a line of its own. What a match resolves to is always its fully
 * qualified key, including for an environment variable name, because the key is
 * what the rest of the run proceeds with.
 *
 * @param match - The match the run proceeds with.
 * @param search - The reference exactly as it was written.
 * @param reason - The closing sentence, when the caller has one of its own.
 */
export function resolvedReferenceFacts(
  match: ReferenceMatch,
  search: string,
  reason?: string
): ResolvedReferenceFacts {
  const isRepository = match.scope === SousScope.Repository;
  const resolvedTo = match.key;

  return {
    search,
    resolvedTo,
    kind: SCOPE_LABELS[match.scope],
    ...(match.variable === undefined ? {} : { variable: match.variable }),
    ...(match.recipe === undefined ? {} : { recipe: match.recipe }),
    ...(match.namespace === undefined ? {} : { namespace: match.namespace }),
    ...(match.repo === undefined || match.repo === resolvedTo ? {} : { repository: match.repo }),
    ...(isRepository && match.detail !== undefined ? { location: match.detail } : {}),
    ...(!isRepository && match.detail !== undefined ? { description: match.detail } : {}),
    ...(reason === undefined ? {} : { reason }),
  };
}
