/**
 * What an update is about to do, written out before it asks.
 *
 * `sous subscription update` (and `sous repo unlink --update`, which runs the
 * same code) works out the whole change first: which pins move, which
 * dependencies arrive or leave, which repositories a newer version needs that
 * the project does not trust yet, and which questions the new versions ask.
 * This module turns those facts into the lines printed above the one question.
 * It is pure: it formats what it is handed and decides nothing.
 */

import type { LockDiff } from "./lock-service.js";
import type { MissingRepo } from "./resolver.js";
import { formatQuestionPlan, type PlannedVariable } from "../vars/index.js";
import { BULLET, palette, wrapColumns, wrapText } from "../../utils/formatting.js";

/** What an update narrowed itself to. */
export type UpdateScope =
  | { kind: "all" }
  | { kind: "repository"; repo: string }
  | { kind: "namespace"; repo: string; namespace: string }
  | { kind: "recipe"; repo: string; key: string };

/** Everything the plan says, gathered by the subscription service. */
export type UpdatePlanFacts = {
  /** What the update covers. */
  scope: UpdateScope;
  /** What would change in the lockfile. */
  diff: LockDiff;
  /** Repositories a newer version needs that the project does not trust yet. */
  missingRepos: MissingRepo[];
  /** The questions the new versions ask that nothing answers yet. */
  questions: PlannedVariable[];
  /** Recipes whose files are not on this machine and whose index does not record their questions. */
  unreadable: string[];
  /** Repositories whose index could not be fetched, so their pins stay where they are. */
  unreachable: Array<{ repo: string; reason: string }>;
  /** Linked repositories whose pins move, which builds keep bypassing. */
  linked: string[];
  /** Subscriptions sous provides itself, held at the version this sous ships. */
  builtIn: Array<{ key: string; version?: string }>;
  /** Switched-off subscriptions the update left alone. */
  switchedOff: string[];
  /** Subscriptions that could not be resolved, each with the reason. */
  failed: Array<{ key: string; reason: string }>;
};

/**
 * The scope in words, for a sentence that has to say what was updated.
 *
 * describeUpdateScope({ kind: "repository", repo: "sous-recipes" })
 * // -> "the recipes this project takes from the repository 'sous-recipes'"
 *
 * @param scope - What the update covers.
 */
export function describeUpdateScope(scope: UpdateScope): string {
  switch (scope.kind) {
    case "all":
      return "every subscription in this project";
    case "repository":
      return `the recipes this project takes from the repository '${scope.repo}'`;
    case "namespace":
      return `the recipes in the namespace '${scope.repo}:${scope.namespace}'`;
    case "recipe":
      return `the recipe '${scope.repo}:${scope.key}'`;
  }
}

/**
 * True when the plan has nothing to do: no pin moves, nothing arrives or
 * leaves, and no new repository is needed.
 *
 * @param facts - What the service worked out.
 */
export function isEmptyUpdate(facts: Pick<UpdatePlanFacts, "diff" | "missingRepos">): boolean {
  return facts.diff.unchanged && facts.missingRepos.length === 0;
}

/**
 * The plan, as lines ready to be indented and printed. Pin changes come first,
 * then the repositories that need trusting, then the questions, then the notes
 * about what the update deliberately left alone.
 *
 * @param facts - What the service worked out.
 * @param options - The width to wrap to, for tests.
 */
export function formatUpdatePlan(
  facts: UpdatePlanFacts,
  options: { width?: number } = {}
): string[] {
  const width = (options.width ?? wrapColumns()) - 4;
  const lines: string[] = [""];

  /** One sentence, wrapped. */
  const sentence = (text: string, paint = (line: string): string => line): string[] =>
    wrapText(text, width).map(paint);

  /** One bullet, wrapped so its continuation hangs under the text. */
  const bullet = (text: string): string[] =>
    wrapText(`  ${BULLET} ${text}`, width, { hangingIndent: 2 });

  if (isEmptyUpdate(facts)) {
    lines.push(
      ...sentence(
        `Nothing to update: every pin in ${describeUpdateScope(facts.scope)} is ` +
          `already the newest published version its range allows.`
      )
    );
  } else {
    lines.push(...sentence(`Updating ${describeUpdateScope(facts.scope)} changes the lockfile:`));
    lines.push("");
    if (facts.diff.unchanged) {
      lines.push(
        ...bullet("No pin moves until the repositories below are trusted and read.")
      );
    } else {
      for (const change of facts.diff.lines) lines.push(...bullet(change));
    }
  }

  if (facts.missingRepos.length > 0) {
    lines.push("");
    lines.push(
      ...sentence(
        `A newer version needs ${
          facts.missingRepos.length === 1 ? "a repository" : "repositories"
        } this project ${palette.highlight("does not trust yet")}. You are asked about ` +
          `each one by name before anything is fetched from it:`,
        palette.warning
      )
    );
    lines.push("");
    for (const missing of facts.missingRepos) {
      const where = missing.url === undefined ? "" : ` at ${missing.url}`;
      const needers = missing.requiredBy.map((entry) => entry.requestedBy).join(", ");
      lines.push(...bullet(`${missing.name}${where}, needed by ${needers}`));
    }
  }

  if (facts.questions.length > 0 || facts.unreadable.length > 0) {
    lines.push("");
    lines.push(...sentence("Questions the new versions ask that nothing answers yet:"));
    lines.push("");
    for (const line of formatQuestionPlan(facts.questions, {
      unreadable: facts.unreadable,
      width,
    })) {
      lines.push(line === "" ? "" : `  ${line}`);
    }
  }

  const notes: string[] = [];
  if (facts.unreadable.length > 0) {
    notes.push(
      `A dry run downloads no recipe, so the dependencies of the versions not on this ` +
        `machine yet, and not described by their index, are not shown: ` +
        `${facts.unreadable.join(", ")}.`
    );
  }
  for (const entry of facts.unreachable) {
    notes.push(
      `The index of '${entry.repo}' could not be fetched, so its pins stay where ` +
        `they are. ${firstLine(entry.reason)}`
    );
  }
  for (const entry of facts.failed) {
    notes.push(
      `The subscription to '${entry.key}' could not be resolved, so its pins stay ` +
        `where they are. ${firstLine(entry.reason)}`
    );
  }
  for (const repo of facts.linked) {
    notes.push(
      `The repository '${repo}' is linked to a working copy, so builds keep ` +
        `reading that checkout until it is unlinked; the pins above take effect then.`
    );
  }
  for (const entry of facts.builtIn) {
    notes.push(
      `The subscription to '${entry.key}' is one sous provides itself, and it stays ` +
        `at ${
          entry.version === undefined ? "the version" : `version ${entry.version}, the version`
        } this installation of sous ships.`
    );
  }
  if (facts.switchedOff.length > 0) {
    notes.push(
      `Switched off, so left alone: ${facts.switchedOff.join(", ")}.`
    );
  }

  if (notes.length > 0) {
    lines.push("");
    for (const text of notes) {
      lines.push(...wrapText(`${BULLET} ${text}`, width, { hangingIndent: 2 }).map(palette.note));
    }
  }

  lines.push("");
  return lines;
}

/**
 * The first line of a possibly multi-line reason, which is what fits in a note.
 *
 * @param text - The reason.
 */
function firstLine(text: string): string {
  return text.split("\n")[0]!.trim();
}

/**
 * True when an update of this scope may move a recipe, judged by the recipe's
 * key and the repository it comes from.
 *
 * recipeInScope({ kind: "namespace", repo: "r", namespace: "workflow" }, "workflow/x", "r")
 * // -> true
 *
 * @param scope - What the update covers.
 * @param key - The recipe key, `namespace/recipe`.
 * @param repo - The short name of the repository it comes from.
 */
export function recipeInScope(scope: UpdateScope, key: string, repo: string): boolean {
  switch (scope.kind) {
    case "all":
      return true;
    case "repository":
      return repo === scope.repo;
    case "namespace":
      return repo === scope.repo && key.startsWith(`${scope.namespace}/`);
    case "recipe":
      return repo === scope.repo && key === scope.key;
  }
}

