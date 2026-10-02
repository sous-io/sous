/**
 * The ref parser: the one place a written ref becomes the things it could mean.
 *
 * It is context free. It never asks where the ref was written (that is for a
 * pruner) and never asks what exists (that is for a lookup); it returns EVERY
 * way the text can be read, because some forms read more than one way: a bare
 * `workflow` is a namespace, a recipe, a repository, a variable and an
 * environment variable name, and a GitLab URL with nested groups does not say
 * where the project path ends.
 *
 * The parser is a list of splitters, ordered by their `order`. Each reads
 * whatever part of the remaining text it recognizes and returns every way to
 * read it; the parser feeds every reading through every splitter with
 * `flatMap`, and keeps the readings that ended with a finished ref and no text
 * left over. A plugin adds a form by adding a splitter.
 */

import { makeInjectable } from "../injectable.js";
import { REF_TOKENS } from "../tokens.js";
import { ConfigError } from "../../../lib/errors.js";
import type { RefSplitter, PartialRef } from "./partial-ref.js";
import { REF_KINDS, type SousRef } from "../types.js";

/** The forms a ref may take, for the reminder under a ref that does not parse. */
const SYNTAX_HELP =
  "A ref is written as 'namespace', 'namespace/recipe', 'repo:namespace/recipe', " +
  "'namespace/recipe/path/to/file.md', 'namespace/recipe.variable', an environment variable " +
  "name, any of those with '@<range>' or '?name=value', or a location such as " +
  "'github://owner/repository/namespace/recipe' or a URL copied from the browser.";

/** Parses written refs into every reading they have. */
export class RefParser {
  private readonly splitters: RefSplitter[];

  /**
   * @param splitters - The splitters, in any order; they run by their `order`.
   */
  constructor(splitters: RefSplitter[]) {
    this.splitters = [...splitters].sort((left, right) => left.order - right.order);
  }

  /**
   * Every reading of a written ref.
   *
   * parser.parse("workflow/alpha@^1.2");
   * // -> [{ kind: "recipe", name: "alpha", namespace: { kind: "namespace", name: "workflow" },
   * //       range: "^1.2" }]
   *
   * @param input - The ref exactly as it was written.
   * @returns Every reading, never empty. Text that fits no form raises a ConfigError.
   */
  parse(input: string): SousRef[] {
    if (typeof input !== "string") throw this.refError(String(input), "a ref must be a string.");

    const trimmed = input.trim();
    if (trimmed.length === 0) throw this.refError(input, "a ref must not be empty.");
    if (trimmed.startsWith("@")) {
      throw this.refError(
        input,
        "refs take no '@' prefix. The '@' character introduces a version range only, " +
          "as in 'workflow/task-files@^1.2.0'."
      );
    }
    if (trimmed.startsWith("~")) {
      throw this.refError(
        input,
        "refs take no '~' prefix. The '~' sigil belongs to template include lines " +
          "('@~workflow/file.md'); a ref itself is written without it."
      );
    }

    const problems: string[] = [];
    let states: PartialRef[] = [{ input: trimmed, rest: trimmed, problems }];
    for (const splitter of this.splitters) {
      states = states.flatMap((state) => splitter.split(state));
      if (states.length === 0) break;
    }

    const seen = new Set<string>();
    const refs: SousRef[] = [];
    for (const state of states) {
      if (state.ref === undefined || state.rest !== "") continue;
      const key = JSON.stringify(state.ref);
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(state.ref);
    }
    // Kinds in their documented order, whatever order the splitters made them in.
    if (refs.length > 0) {
      return refs
        .map((ref, position) => ({ ref, position }))
        .sort(
          (left, right) =>
            REF_KINDS.indexOf(left.ref.kind) - REF_KINDS.indexOf(right.ref.kind) ||
            left.position - right.position
        )
        .map((entry) => entry.ref);
    }

    const reasons = [...new Set(problems)];
    if (reasons.length === 0) throw this.refError(input, "it does not fit any form of a ref.");
    if (reasons.length === 1) throw this.refError(input, reasons[0]!);
    throw this.refError(
      input,
      `it fits no form of a ref:\n${reasons.map((reason) => `    ${reason}`).join("\n")}`
    );
  }

  /** A ConfigError for text that fits no form, quoting it and showing the forms. */
  private refError(input: string, problem: string): ConfigError {
    return new ConfigError(`Invalid ref '${input}': ${problem}\n  ${SYNTAX_HELP}`);
  }
}

makeInjectable(RefParser, [{ multi: REF_TOKENS.Splitter }]);
