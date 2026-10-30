/**
 * The views of building: `build`, `compile`, `build.prepare`, `prune`, `clear`, `build.watch` and
 * `launch`.
 *
 * Today's CLI printed a build's progress as it went: each target's entry point and outputs, every
 * pruned file, the lockfile and restore notices. The intents now report all of that through the
 * chain's reporter while they run (`plugin-build`'s `report.ts`, the compiler's per-output lines),
 * so these views add nothing that would print twice. What is left for them is what only the result
 * knows: a failed build exits 1, as before, and `build.prepare` (which reports nothing itself) shows
 * what preparing did, laid out as today's `src/lib/build-preparation.ts` did.
 */

import { projectVariables } from "../command-variables.js";
import type { CliViewContext, CliViewEntity, CliViewOutput } from "../../types.js";
import type { Printer } from "../printer.js";
import { BULLET } from "../text.js";

// ---------------------------------------------------------------------------------------------
// The result shapes these views read (from plugin-build, plugin-compiler, plugin-recipes and
// plugin-harnesses; declared here so plugin-cli depends on none of them)
// ---------------------------------------------------------------------------------------------

/** A pin that was added or moved. */
export interface LockChangeShape {
    readonly key: string;
    readonly from?: string;
    readonly to?: string;
}

/** What changed in the lockfile. */
export interface LockDiffShape {
    readonly added: readonly LockChangeShape[];
    readonly updated: readonly LockChangeShape[];
    readonly unchanged: boolean;
}

/** What restoring the store did. */
export interface RestoreReportShape {
    readonly restored: readonly string[];
    readonly failed: ReadonlyArray<{ readonly key: string; readonly reason: string }>;
}

/** A locked recipe that was not built, and why. */
export interface SkippedRecipeShape {
    readonly key: string;
    readonly reason: string;
    readonly setBy?: string;
    readonly message: string;
}

/** A required variable with no answer. */
export interface UnansweredShape {
    readonly definition: { readonly name: string };
    readonly recipe: { readonly namespace: string; readonly name: string };
}

/** The result of `build.prepare`. */
export interface BuildPrepareResultShape {
    readonly seeded?: readonly string[];
    readonly locked: LockDiffShape;
    readonly restored: RestoreReportShape;
    readonly newer: ReadonlyArray<{ readonly key: string; readonly from: string; readonly to: string }>;
    readonly skipped: readonly SkippedRecipeShape[];
    readonly unanswered: readonly UnansweredShape[];
}

/** The result of `build` and of `compile`: only whether it went cleanly matters here. */
export interface BuildResultShape {
    readonly ok: boolean;
}

/** The result of `launch`. */
export interface LaunchResultShape {
    readonly build?: BuildResultShape;
}

// ---------------------------------------------------------------------------------------------
// The views
// ---------------------------------------------------------------------------------------------

/**
 * `build` and `compile`: the progress was reported as it happened, so a clean build prints nothing
 * more, and a failed one exits 1 (as `sous build` and `sous compile` did).
 */
export function buildView(result: BuildResultShape, view: CliViewContext): CliViewOutput {
    const entries: Record<string, unknown> = projectVariables(view);

    for (const [label, flag] of [["Rebuild", "rebuild"], ["Dry Run", "dry-run"], ["No Compile", "no-compile"], ["No Prune", "no-prune"]] as const) {
        if (view.input[flag] === true || view.input[camel(flag)] === true) {
            entries[label] = true;
        }
    }

    if (Object.keys(entries).length === 0) {
        return result.ok ? undefined : { exitCode: 1 };
    }

    const out = view.printer();

    out.subheading("Command Variables", "$");
    out.variables(entries);

    return result.ok ? out.text() : { stdout: out.text(), exitCode: 1 };
}

/** `dry-run` as an input key: `dryRun`. */
function camel(flag: string): string {
    return flag.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

/** Nothing to add: the intent reported everything while it ran (`prune`, `clear`, `build.watch`, `launch`). */
export function silentView(): CliViewOutput {
    return undefined;
}

/**
 * `build.prepare` on its own: what preparing did, in the layout of today's
 * `src/lib/build-preparation.ts`. A build reports the same facts itself while it runs, so this
 * shows only when `build.prepare` is the command.
 *
 * ```text
 * ▶ Locking subscribed recipes:
 *
 *   pinned: core/sous-skills at version 0.2.34.
 *
 *   The lockfile has been updated. Commit it, so everyone building this project gets exactly these
 *     versions.
 * ```
 */
export function prepareView(result: BuildPrepareResultShape, view: CliViewContext): CliViewOutput {
    const out = view.printer();

    writePrepared(out, result);

    return out.text();
}

/** Writes what preparing did. */
export function writePrepared(out: Printer, result: BuildPrepareResultShape): void {
    if (result.restored.restored.length > 0) {
        out.heading("Restoring recipes").blank();
        out.paragraph("This project's lockfile pins recipes that were not in the store on this machine, so they were fetched at exactly the versions it records.");
        out.blank();

        for (const key of result.restored.restored) {
            out.paragraph(`  restored: ${key}`);
        }

        out.footer();
    }

    const locked = result.locked;

    if (!locked.unchanged && (locked.added.length > 0 || locked.updated.length > 0)) {
        out.heading("Locking subscribed recipes").blank();

        for (const change of locked.added) {
            out.paragraph(`  pinned: ${change.key} at version ${change.to ?? "?"}.`);
        }

        for (const change of locked.updated) {
            out.paragraph(`  ${change.key} moved from version ${change.from ?? "?"} to version ${change.to ?? "?"}.`);
        }

        out.blank();
        out.paragraph("The lockfile has been updated. Commit it, so everyone building this project gets exactly these versions.");
        out.footer();
    }

    for (const failure of result.restored.failed) {
        out.warning(`Sous could not restore '${failure.key}' at the version the lockfile pins, so nothing from it was compiled.\n${failure.reason}`);
    }

    if (result.newer.length > 0) {
        out.section("Newer versions published");
        out.variables(result.newer.map((entry) => ({ label: entry.key, value: entry.to, detail: `this project pins ${entry.from}` })));
        out.blank();
        out.note(
            result.newer.length === 1
                ? "This version is within the range declared for the recipe. No pin was changed, so this build uses the pinned version."
                : "Each version is within the range declared for its recipe. No pin was changed, so this build uses the pinned versions.",
        );
        out.footer();
    }

    if (result.unanswered.length > 0) {
        out.warning(unansweredMessage(result.unanswered));
    }

    for (const skipped of result.skipped) {
        out.paragraph(skippedLine(skipped));
    }
}

/** The warning for required variables nothing answered. */
export function unansweredMessage(unanswered: readonly UnansweredShape[]): string {
    const count = unanswered.length;
    const one = count === 1;
    const pronoun = one ? "it" : "them";
    const lines = unanswered.map((defined) => `  ${BULLET} ${defined.definition.name} (asked by ${defined.recipe.namespace}/${defined.recipe.name})`);

    return (
        `${count} required recipe ${one ? "variable" : "variables"} ${one ? "has" : "have"} no answer, so the templates that use ${pronoun} render an empty value:\n` +
        `${lines.join("\n")}\n` +
        `Run 'sous vars ask' to answer ${pronoun}.`
    );
}

/** One line for a skipped recipe, saying why. */
export function skippedLine(skipped: SkippedRecipeShape): string {
    const where = skipped.setBy ? ` (${skipped.setBy})` : "";

    switch (skipped.reason) {
        case "subscription-disabled":
            return `Skipped ${skipped.key}: its subscription is switched off${where}.`;
        case "repository-disabled":
            return `Skipped ${skipped.key}: its repository is switched off${where}.`;
        default: {
            const message = skipped.message.replace(/\.$/u, "");

            return `Skipped ${skipped.key}: ${message.length === 0 ? message : message[0]!.toLowerCase() + message.slice(1)}.`;
        }
    }
}

/** The views of this domain, by intent. */
export const views: Record<string, CliViewEntity["render"]> = {
    build: buildView,
    compile: buildView,
    "build.prepare": prepareView,
    prune: silentView,
    clear: silentView,
    "build.watch": silentView,
    launch: silentView,
};
