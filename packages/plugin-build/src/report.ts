/**
 * What a build says while it runs, worded as before the refactor. Every message goes through the
 * chain's `Reporter` (L3); the front end decides how it looks.
 */

import type { Memory } from "@sous-io/plugin-memories/types";
import type { Reporter } from "@sous-io/plugin-api";
import type { DefinedVariable } from "@sous-io/plugin-recipe-answers/types";
import type { LockDiff, ResolvedLink, RestoreReport, SkippedRecipe } from "@sous-io/plugin-recipes/types";
import type { BuildPrepareResult } from "./types.js";

/** The bullet lists use. */
export const BULLET = "•";

/** The warning for memories no output included, or `undefined` when there are none. */
export function unincludedMemoriesMessage(missing: readonly Memory[]): string | undefined {
    if (missing.length === 0) {
        return undefined;
    }

    const one = missing.length === 1;

    return (
        `${missing.length} ${one ? "memory" : "memories"} published by your subscribed recipes ${one ? "is" : "are"} ` +
        `not included in any output, so no agent will read ${one ? "it" : "them"}:\n` +
        missing.map((memory) => `${BULLET} ${memory.recipe}: memories/${memory.name}`).join("\n") +
        `\nTo include every memory, add the line "@#memories/**/*.md" to your project's instruction ` +
        `source (the file your AGENTS.md or CLAUDE.md is built from). To leave a recipe's memories out on purpose, ` +
        `list the recipe in "recipes.memories.exclude" in your sous config.`
    );
}

/** The lines announcing linked repositories, or none. */
export function linkedReposMessage(links: Readonly<Record<string, ResolvedLink>>): string | undefined {
    const names = Object.keys(links).sort();

    if (names.length === 0) {
        return undefined;
    }

    const lines = [
        names.length === 1
            ? "One repository is LINKED to a working copy on this machine."
            : `${names.length} repositories are LINKED to working copies on this machine.`,
        "Their recipes are read from those checkouts, so versions, the lockfile and",
        "freshness checks do not apply to them.",
        "",
        ...names.map((name) => `${name} -> ${links[name]!.path}`),
        "",
        "Run 'sous repo unlink <name>' to go back to the published versions.",
    ];

    return lines.join("\n");
}

/** The lines about pins that were added or moved, or none. */
export function lockedMessage(diff: LockDiff): string | undefined {
    if (diff.unchanged || (diff.added.length === 0 && diff.updated.length === 0)) {
        return undefined;
    }

    const lines = [
        ...diff.added.map((change) => `  pinned: ${change.key} at version ${change.to ?? "?"}.`),
        ...diff.updated.map((change) => `  ${change.key} moved from version ${change.from ?? "?"} to version ${change.to ?? "?"}.`),
        "",
        "The lockfile has been updated. Commit it, so everyone building this project gets exactly these versions.",
    ];

    return lines.join("\n");
}

/** The lines about restored recipes, or none. */
export function restoredMessage(report: RestoreReport): string | undefined {
    return report.restored.length === 0 ? undefined : report.restored.map((key) => `  restored: ${key}`).join("\n");
}

/** One warning per recipe that could not be restored. */
export function restoreFailures(report: RestoreReport): string[] {
    return report.failed.map(
        (failure) => `Sous could not restore '${failure.key}' at the version the lockfile pins, so nothing from it was compiled.\n${failure.reason}`,
    );
}

/**
 * The newer versions published within range, as a fact: one line per recipe, the newer version
 * beside the pinned one. Nothing moved, and the closing sentence says so.
 */
export function newerMessage(newer: BuildPrepareResult["newer"]): string | undefined {
    if (newer.length === 0) {
        return undefined;
    }

    const lines = [
        "Newer versions published:",
        ...newer.map((entry) => `  ${entry.key}: ${entry.to} this project pins ${entry.from}`),
        "",
        newer.length === 1
            ? "This version is within the range declared for the recipe. No pin was changed, so this build uses the pinned version."
            : "Each version is within the range declared for its recipe. No pin was changed, so this build uses the pinned versions.",
    ];

    return lines.join("\n");
}

/**
 * One line per skipped recipe, saying why (S4, 3, rule 4).
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
            return `Skipped ${skipped.key}: ${lowerFirst(skipped.message.replace(/\.$/u, ""))}.`;
    }
}

/** The line under a skipped recipe saying how many of its outputs were pruned. */
export function prunedForSkippedLine(count: number, dryRun: boolean): string {
    const outputs = count === 1 ? "output" : "outputs";

    return dryRun ? `Would prune ${count} ${outputs} it had written.` : `Pruned ${count} ${outputs} it had written.`;
}

/**
 * The warning for required variables nothing answered, or none.
 *
 * ```text
 * 1 required recipe variable has no answer, so the templates that use it render an empty value:
 *   • jiraKey (asked by acme/jira)
 * Run 'sous vars ask' to answer it.
 * ```
 */
export function unansweredMessage(unanswered: readonly DefinedVariable[]): string | undefined {
    if (unanswered.length === 0) {
        return undefined;
    }

    const count = unanswered.length;
    const noun = count === 1 ? "variable" : "variables";
    const pronoun = count === 1 ? "it" : "them";
    const lines = unanswered.map((defined) => `  ${BULLET} ${defined.definition.name} (asked by ${defined.recipe.namespace}/${defined.recipe.name})`);

    return (
        `${count} required recipe ${noun} ${count === 1 ? "has" : "have"} no answer, so the templates that use ${pronoun} render an empty value:\n` +
        `${lines.join("\n")}\n` +
        `Run 'sous vars ask' to answer ${pronoun}.`
    );
}

/** Reports what preparing did, as a build shows it. */
export function reportPrepared(result: BuildPrepareResult, reporter: Reporter): void {
    const locked = lockedMessage(result.locked);

    if (locked) {
        reporter.note(`Locking subscribed recipes\n${locked}`);
    }

    const restored = restoredMessage(result.restored);

    if (restored) {
        reporter.note(`Restoring recipes\nThis project's lockfile pins recipes that were not in the store on this machine, so they were fetched at exactly the versions it records.\n${restored}`);
    }

    for (const failure of restoreFailures(result.restored)) {
        reporter.warning(failure);
    }

    const newer = newerMessage(result.newer);

    if (newer) {
        reporter.note(newer);
    }

    const unanswered = unansweredMessage(result.unanswered);

    if (unanswered) {
        reporter.warning(unanswered);
    }
}

function lowerFirst(text: string): string {
    return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}
