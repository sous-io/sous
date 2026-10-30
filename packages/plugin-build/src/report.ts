/**
 * What a build says while it runs. Every message goes through the chain's `Reporter`, with the
 * facts as details; the front end decides how it looks.
 */

import type { Memory } from "@sous-io/plugin-memories/types";
import { LogLevel, type Reporter } from "@sous-io/plugin-api";
import type { DefinedVariable } from "@sous-io/plugin-recipe-answers/types";
import type { LockDiff, ResolvedLink, RestoreReport, SkippedRecipe } from "@sous-io/plugin-recipes/types";
import type { BuildPrepareResult, UnansweredWarning } from "./types.js";

/** Warns about memories no output included, or says nothing when there are none. */
export function reportUnincludedMemories(missing: readonly Memory[], reporter: Reporter): void {
    if (missing.length === 0) {
        return;
    }

    const one = missing.length === 1;

    reporter.list(
        missing.map((memory) => `${memory.recipe}: memories/${memory.name}`),
        {
            title:
                `${missing.length} ${one ? "memory" : "memories"} published by your subscribed recipes ${one ? "is" : "are"} ` +
                `not included in any output, so no agent will read ${one ? "it" : "them"}:`,
            footer:
                `To include every memory, add the line "@#memories/**/*.md" to your project's instruction ` +
                `source (the file your AGENTS.md or CLAUDE.md is built from). To leave a recipe's memories out on purpose, ` +
                `list the recipe in "recipes.memories.exclude" in your sous config.`,
        },
        LogLevel.Warning,
    );
}

/** Announces linked repositories at `level`, or says nothing when none are linked. */
export function reportLinkedRepos(links: Readonly<Record<string, ResolvedLink>>, reporter: Reporter, level: LogLevel): void {
    const names = Object.keys(links).sort();

    if (names.length === 0) {
        return;
    }

    const lead = names.length === 1 ? "One repository is LINKED to a working copy on this machine." : `${names.length} repositories are LINKED to working copies on this machine.`;

    reporter.list(
        names.map((name) => `${name} -> ${links[name]!.path}`),
        {
            title: `${lead} Their recipes are read from those checkouts, so versions, the lockfile and freshness checks do not apply to them.`,
            footer: "Run 'sous repo unlink <name>' to go back to the published versions.",
        },
        level,
    );
}

/** Reports pins that were added or moved, or says nothing. */
function reportLocked(diff: LockDiff, reporter: Reporter): void {
    if (diff.unchanged || (diff.added.length === 0 && diff.updated.length === 0)) {
        return;
    }

    reporter.list(
        [
            ...diff.added.map((change) => `pinned: ${change.key} at version ${change.to ?? "?"}.`),
            ...diff.updated.map((change) => `${change.key} moved from version ${change.from ?? "?"} to version ${change.to ?? "?"}.`),
        ],
        {
            title: "Locking subscribed recipes",
            footer: "The lockfile has been updated. Commit it, so everyone building this project gets exactly these versions.",
        },
        LogLevel.Notice,
    );
}

/** Reports restored recipes, or says nothing. */
function reportRestored(report: RestoreReport, reporter: Reporter): void {
    if (report.restored.length === 0) {
        return;
    }

    reporter.stepStart("Restoring recipes", LogLevel.Notice);
    reporter.note("This project's lockfile pins recipes that were not in the store on this machine, so they were fetched at exactly the versions it records.");
    reporter.list(report.restored.map((key) => `restored: ${key}`), {}, LogLevel.Notice);
}

/** One problem per recipe that could not be restored. */
function reportRestoreFailures(report: RestoreReport, reporter: Reporter): void {
    for (const failure of report.failed) {
        reporter.problem(`Sous could not restore '${failure.key}' at the version the lockfile pins, so nothing from it was compiled.`, {
            subject: failure.key,
            cause: failure.reason,
        });
    }
}

/**
 * The newer versions published within range, as a fact: each recipe with the newer version, and
 * the pinned one beside it. Nothing moved, and the closing sentence says so.
 */
function reportNewer(newer: BuildPrepareResult["newer"], reporter: Reporter): void {
    if (newer.length === 0) {
        return;
    }

    reporter.variables(
        newer.map((entry) => ({ label: entry.key, value: entry.to, detail: `this project pins ${entry.from}` })),
        "Newer versions published",
        LogLevel.Notice,
    );
    reporter.note(
        newer.length === 1
            ? "This version is within the range declared for the recipe. No pin was changed, so this build uses the pinned version."
            : "Each version is within the range declared for its recipe. No pin was changed, so this build uses the pinned versions.",
    );
}

/**
 * One line per skipped recipe, saying why.
 *
 * ```ts
 * skippedLine({ key: "tool-usage/automated-browser-tasks", reason: "subscription-disabled", setBy: "conf.d/610-mac.jsonc", message: "..." });
 * // "Skipped tool-usage/automated-browser-tasks: its subscription is switched off (conf.d/610-mac.jsonc)."
 * ```
 */
export function skippedLine(skipped: SkippedRecipe): string {
    const where = skipped.setBy ? ` (${skipped.setBy})` : "";

    switch (skipped.reason) {
        case "subscription-disabled":
            return `Skipped ${skipped.key}: its subscription is switched off${where}.`;
        case "repository-disabled":
            return `Skipped ${skipped.key}: its repository is switched off${where}.`;
        default:
            // A message that names the recipe already is a whole line.
            return skipped.message.startsWith("Skipped ") ? skipped.message : `Skipped ${skipped.key}: ${lowerFirst(skipped.message.replace(/\.$/u, ""))}.`;
    }
}

/** The line under a skipped recipe saying how many of its outputs were pruned. */
export function prunedForSkippedLine(count: number, dryRun: boolean): string {
    const outputs = count === 1 ? "output" : "outputs";

    return dryRun ? `Would prune ${count} ${outputs} it had written.` : `Pruned ${count} ${outputs} it had written.`;
}

/**
 * The warning for required variables nothing answered: a title, the variables (each with the
 * recipe that asks it) and what to do about them. `undefined` when everything is answered.
 *
 * ```text
 * 1 required recipe variable has no answer, so the templates that use it render an empty value:
 *   - jiraKey (asked by acme/jira)
 * Run 'sous vars ask' to answer it.
 * ```
 */
export function unansweredWarning(unanswered: readonly DefinedVariable[]): UnansweredWarning | undefined {
    if (unanswered.length === 0) {
        return undefined;
    }

    const count = unanswered.length;
    const pronoun = count === 1 ? "it" : "them";

    return {
        title: `${count} required recipe ${count === 1 ? "variable" : "variables"} ${count === 1 ? "has" : "have"} no answer, so the templates that use ${pronoun} render an empty value:`,
        items: unanswered.map((defined) => `${defined.definition.name} (asked by ${defined.recipe.namespace}/${defined.recipe.name})`),
        footer: `Run 'sous vars ask' to answer ${pronoun}.`,
    };
}

/** Warns about required variables nothing answered, or says nothing. */
export function reportUnanswered(unanswered: readonly DefinedVariable[], reporter: Reporter): void {
    const warning = unansweredWarning(unanswered);

    if (warning !== undefined) {
        reporter.list(warning.items, { title: warning.title, footer: warning.footer }, LogLevel.Warning);
    }
}

/** Reports what preparing did, as a build shows it. */
export function reportPrepared(result: BuildPrepareResult, reporter: Reporter): void {
    reportLocked(result.locked, reporter);
    reportRestored(result.restored, reporter);
    reportRestoreFailures(result.restored, reporter);
    reportNewer(result.newer, reporter);
    reportUnanswered(result.unanswered, reporter);
}

function lowerFirst(text: string): string {
    return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}
