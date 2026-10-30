/**
 * The views of building: `build`, `compile`, `prune`, `clear`, `build.watch` and
 * `launch`.
 *
 * Today's CLI printed a build's progress as it went: each target's entry point and outputs, every
 * pruned file, the lockfile and restore notices. The intents now report all of that through the
 * chain's reporter while they run (`plugin-build`'s `report.ts`, the compiler's per-output lines),
 * so these views add nothing that would print twice. What is left for them is what only the result
 * knows: a failed build exits 1, as before. `build.prepare` is internal and reports the lockfile, restore
 * and version facts itself, so it has no view.
 */

import type { CliViewContext, CliViewEntity, CliViewOutput } from "../../types.js";
import { projectVariables } from "../command-variables.js";

// ---------------------------------------------------------------------------------------------
// The result shapes these views read (from plugin-build, plugin-compiler, plugin-recipes and
// plugin-harnesses; declared here so plugin-cli depends on none of them)
// ---------------------------------------------------------------------------------------------

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

/** The views of this domain, by intent. */
export const views: Record<string, CliViewEntity["render"]> = {
    build: buildView,
    compile: buildView,
    prune: silentView,
    clear: silentView,
    "build.watch": silentView,
    launch: silentView,
};
