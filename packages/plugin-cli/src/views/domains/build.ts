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

import { LogLevel, type Reporter } from "@sous-io/plugin-api";
import type { CliViewContext, CliViewEntity, CliViewOutput } from "../../types.js";
import { projectVariables } from "../command-variables.js";

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

/** The warning for required variables nothing answered (plugin-build's `UnansweredWarning`). */
export interface UnansweredWarningShape {
    readonly title: string;
    readonly items: readonly string[];
    readonly footer: string;
}

/** The result of `build.prepare`. */
export interface BuildPrepareResultShape {
    readonly seeded?: readonly string[];
    readonly locked: LockDiffShape;
    readonly restored: RestoreReportShape;
    readonly newer: ReadonlyArray<{ readonly key: string; readonly from: string; readonly to: string }>;
    /** One finished sentence per skipped recipe. */
    readonly skippedLines: readonly string[];
    readonly unansweredWarning?: UnansweredWarningShape;
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

    view.reporter.commandVariables(entries);

    return result.ok ? undefined : { exitCode: 1 };
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
 */
export function prepareView(result: BuildPrepareResultShape, view: CliViewContext): CliViewOutput {
    reportPrepared(view.reporter, result);

    return undefined;
}

/** Reports what preparing did. */
export function reportPrepared(reporter: Reporter, result: BuildPrepareResultShape): void {
    if (result.restored.restored.length > 0) {
        reporter.operationStart("Restoring recipes");
        reporter.list(
            result.restored.restored.map((key) => `restored: ${key}`),
            { title: "This project's lockfile pins recipes that were not in the store on this machine, so they were fetched at exactly the versions it records." },
        );
    }

    const locked = result.locked;

    if (!locked.unchanged && (locked.added.length > 0 || locked.updated.length > 0)) {
        reporter.operationStart("Locking subscribed recipes");
        reporter.list([
            ...locked.added.map((change) => `pinned: ${change.key} at version ${change.to ?? "?"}.`),
            ...locked.updated.map((change) => `${change.key} moved from version ${change.from ?? "?"} to version ${change.to ?? "?"}.`),
        ]);
        reporter.info("The lockfile has been updated. Commit it, so everyone building this project gets exactly these versions.");
    }

    for (const failure of result.restored.failed) {
        reporter.problem(`Sous could not restore '${failure.key}' at the version the lockfile pins, so nothing from it was compiled.`, { cause: failure.reason });
    }

    if (result.newer.length > 0) {
        reporter.operationStart("Newer versions published");
        reporter.variables(result.newer.map((entry) => ({ label: entry.key, value: entry.to, detail: `this project pins ${entry.from}` })));
        reporter.note(
            result.newer.length === 1
                ? "This version is within the range declared for the recipe. No pin was changed, so this build uses the pinned version."
                : "Each version is within the range declared for its recipe. No pin was changed, so this build uses the pinned versions.",
        );
    }

    if (result.unansweredWarning !== undefined) {
        reporter.list(result.unansweredWarning.items, { title: result.unansweredWarning.title, footer: result.unansweredWarning.footer }, LogLevel.Warning);
    }

    for (const line of result.skippedLines) {
        reporter.info(line);
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
