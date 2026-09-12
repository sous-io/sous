/**
 * Saying what a reference resolved to.
 *
 * A word on the command line can name a repository, a namespace, a recipe or a
 * variable, and when sous settles which one it means it has to say so. What it
 * resolved to is a set of facts, so it is written as the same key and value
 * list every other set of facts in the CLI is written as, with one short
 * sentence after it saying why that candidate won. One function builds it, so
 * every command that resolves a reference reports it the same way.
 */

import {
  formatVariable,
  indent,
  wrapColumns,
  wrapText,
  type VariableEntry,
} from "../../utils/formatting.js";

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
  /** The publisher's one-line summary, when there is one. */
  description?: string;
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
    ...(facts.description === undefined
      ? []
      : [{ label: "Description", value: facts.description }]),
  ];

  const labelWidth = Math.max(...entries.map((entry) => entry.label.length));
  const lines = entries.flatMap((entry) => formatVariable(entry, { labelWidth }));

  lines.push("");
  for (const line of wrapText(
    `'${facts.search}' named one ${facts.kind}, and nothing else, so that is what ` +
      `is being used.`,
    wrapColumns() - 4
  )) {
    lines.push(indent(line));
  }

  return lines;
}
