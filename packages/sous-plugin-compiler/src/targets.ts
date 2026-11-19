/**
 * Turning the files the config lists (`compilation.files`, one entry per output of each source,
 * listed while the config was built) into units to compile: one per source, each with its outputs
 * and the variables each renders with. Reads nothing from disk: the `compiler.files` contributor
 * already matched every glob.
 */

import type { VarScope, VariablesResolver } from "@sous-io/sous-plugin-variables/types";
import { targetName } from "./files.js";
import type { CompilationFile, CompilationOrigin, CompilationSettings, CompilationTarget, CompileProblem } from "./types.js";

export { targetName };

/** One output of a unit, resolved. */
export interface UnitOutput {
    /** Its index in the target's `outputs`. */
    readonly index: number;
    /** The file it writes, absolute. */
    readonly destination: string;
    /** The variables it renders with. */
    readonly vars: VarScope;
    /** Its own `transforms`, applied after the target's. */
    readonly transforms: readonly string[];
    /** The harness it belongs to (`harness` on the output), which templates read as `harness.id`. */
    readonly harness?: string;
    /** `backupExisting` on the output: a file sous did not write there is backed up, with a warning, and overwritten. */
    readonly backupExisting?: boolean;
}

/** One source to compile, and where it goes. */
export interface CompileUnit {
    /** The target's index in `compilation.targets`. */
    readonly targetIndex: number;
    /** The target's id, or its index as text. */
    readonly targetName: string;
    /** The source file; for a `content` target, a path named after its id under the project root. */
    readonly source: string;
    /** What a message names the source by: the file, or the `content` target's id. */
    readonly label: string;
    /** The template text of a `content` target. */
    readonly content?: string;
    /** Where a `content` target's relative includes resolve: the project root. */
    readonly globBase?: string;
    readonly includeSourceComments: boolean;
    /** The target's variables: what `${var}` in its include paths is substituted from. */
    readonly scope: VarScope;
    readonly transforms: readonly string[];
    readonly origin?: CompilationOrigin;
    readonly outputs: UnitOutput[];
}

/** What making units needs. */
export interface UnitEnvironment {
    readonly resolver: Pick<VariablesResolver, "scope">;
    /** Where a `content` target's includes resolve. */
    readonly projectRoot: string;
}

/** The units of the targets, and the problems listing their files found. */
export interface UnitsResult {
    readonly units: CompileUnit[];
    readonly problems: CompileProblem[];
}

/**
 * The units of the targets, from the files the config lists. The problems the listing found are
 * returned with them, and so is a target added after the listing, which has no files.
 *
 * @param only - The indexes of the targets to compile; default every one.
 */
export function unitsOf(settings: CompilationSettings, env: UnitEnvironment, only?: ReadonlySet<number>): UnitsResult {
    const problems: CompileProblem[] = [];
    const listing = settings.listing;
    const wanted = (index: number | undefined) => index === undefined || only === undefined || only.has(index);

    for (const { targetIndex, ...problem } of listing?.problems ?? []) {
        if (wanted(targetIndex)) {
            problems.push(problem);
        }
    }

    settings.targets.forEach((target, index) => {
        if (wanted(index) && index >= (listing?.targets ?? 0)) {
            problems.push({
                level: "error",
                message: `The files of target ${targetName(target, index)} were never listed: it was added after the compiler listed every target's files (by a contributor in a later config stage), so it is not compiled.`,
                target: targetName(target, index),
            });
        }
    });

    const groups = new Map<string, CompilationFile[]>();

    for (const file of settings.files ?? []) {
        if (!wanted(file.targetIndex) || settings.targets[file.targetIndex] === undefined) {
            continue;
        }

        const key = `${file.targetIndex}\u0000${file.source}`;
        const group = groups.get(key);

        if (group === undefined) {
            groups.set(key, [file]);
        } else {
            group.push(file);
        }
    }

    const units: CompileUnit[] = [];
    const failed = new Set<number>();

    for (const files of groups.values()) {
        const index = files[0]!.targetIndex;

        if (failed.has(index)) {
            continue;
        }

        const target = settings.targets[index]!;

        try {
            units.push(unitOf(settings, target, index, files, env, problems));
        } catch (error) {
            // A variable that cannot be resolved (an unset `_env` value) fails the whole target, once.
            failed.add(index);
            problems.push({ level: "error", message: error instanceof Error ? error.message : String(error), target: targetName(target, index) });
        }
    }

    return { units: yieldToConfigTargets(units, problems), problems };
}

/** One source's unit: its outputs, in their order, each with the variables it renders with. */
function unitOf(
    settings: CompilationSettings,
    target: CompilationTarget,
    index: number,
    files: readonly CompilationFile[],
    env: UnitEnvironment,
    problems: CompileProblem[],
): CompileUnit {
    const name = targetName(target, index);
    const scopeKey = target.origin?.recipe;
    const keyed = scopeKey === undefined ? {} : { scopeKey };
    const source = files[0]!.source;
    const outputs: UnitOutput[] = [];

    for (const file of files) {
        const output = target.outputs[file.output];

        if (output === undefined) {
            continue;
        }

        const transforms = output.transforms ?? [];
        const kept = outputs.find((existing) => existing.destination === file.destination);

        // When several outputs write the same file, the first one is kept; a dropped one that has
        // different transforms is reported, so it is never lost silently.
        if (kept !== undefined) {
            if (JSON.stringify(kept.transforms) !== JSON.stringify(transforms)) {
                problems.push({
                    level: "warning",
                    message: `Outputs ${kept.index} and ${file.output} of target ${name} both write ${file.destination}, with different transforms. Only output ${kept.index} is used.`,
                    target: name,
                    file: file.destination,
                });
            }

            continue;
        }

        // A `compilation.varOverrides` rule's variables are laid over the output's own, so they win.
        const vars = env.resolver.scope({ level: "output", target: index, output: file.output, ...keyed, ...(file._vars === undefined ? {} : { extra: file._vars }) });

        outputs.push({
            index: file.output,
            destination: file.destination,
            vars,
            transforms,
            ...(file.harness === undefined ? {} : { harness: file.harness }),
            ...(output.backupExisting === true ? { backupExisting: true } : {}),
        });
    }

    const base = {
        targetIndex: index,
        targetName: name,
        includeSourceComments: target.includeSourceComments ?? settings.includeSourceComments,
        scope: env.resolver.scope({ level: "target", target: index, ...keyed }),
        transforms: target.transforms ?? [],
        ...(target.origin === undefined ? {} : { origin: target.origin }),
        source,
        outputs,
    };

    if (target.content !== undefined) {
        return { ...base, label: target.id ?? name, content: target.content, globBase: env.projectRoot };
    }

    return { ...base, label: source };
}

/**
 * Drops the outputs a plugin's or a recipe's target would write over a file a target from the
 * project's config writes: the user's own target wins, so the two never write the same file in
 * turn. A unit left with no outputs is dropped. A recipe output that yields is reported as a warning
 * in `problems`, so a project skill shadowing a recipe skill is never silent; a plugin's own target
 * (a memory target's `CLAUDE.md`, say) yields without a word, because yielding is what it is for.
 *
 * ```ts
 * // the config builds CLAUDE.md from .sous/memories/instructions.tpl.md, sous-plugin-memories adds memories/claude-code
 * yieldToConfigTargets(units);
 * // -> memories/claude-code is gone; the config's target writes CLAUDE.md alone
 * ```
 */
export function yieldToConfigTargets(units: readonly CompileUnit[], problems: CompileProblem[] = []): CompileUnit[] {
    const fromConfig = new Set(
        units.filter((unit) => unit.origin === undefined).flatMap((unit) => unit.outputs.map((output) => output.destination)),
    );

    return units.flatMap((unit) => {
        if (unit.origin === undefined || !unit.outputs.some((output) => fromConfig.has(output.destination))) {
            return [unit];
        }

        const recipe = unit.origin.recipe;

        if (recipe !== undefined) {
            for (const output of unit.outputs.filter((candidate) => fromConfig.has(candidate.destination))) {
                problems.push({
                    level: "warning",
                    message: `${output.destination} is written by this project's own target, so the copy from the recipe ${recipe} is not written.`,
                    target: unit.targetName,
                    file: unit.source,
                });
            }
        }

        const outputs = unit.outputs.filter((output) => !fromConfig.has(output.destination));

        return outputs.length === 0 ? [] : [{ ...unit, outputs }];
    });
}
