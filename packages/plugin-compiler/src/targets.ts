/**
 * Turning the config's compilation targets into units to compile: one per source file (an
 * `entryGlob` target gives one per file it matches), each with its outputs resolved, `${var}`
 * substituted and `_if` conditions applied. Reads the disk only to expand globs.
 */

import path from "node:path";
import type { VarScope, VariablesResolver } from "@sous-io/plugin-variables/types";
import { resolveAliasPrefix, type AliasMap } from "./aliases.js";
import { expandPattern, type Globs } from "./globs.js";
import { resolveOutputPath } from "./paths.js";
import type { CompilationOrigin, CompilationSettings, CompilationTarget, CompileProblem } from "./types.js";

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
    readonly globBase?: string;
    readonly includeSourceComments: boolean;
    /** The target's variables: what `${var}` in its include paths is substituted from. */
    readonly scope: VarScope;
    readonly transforms: readonly string[];
    readonly origin?: CompilationOrigin;
    readonly outputs: UnitOutput[];
}

/** What expanding targets needs. */
export interface ExpandEnvironment {
    readonly resolver: Pick<VariablesResolver, "scope" | "substituteStrict" | "normalizePath">;
    readonly aliases: AliasMap;
    readonly globs: Globs;
    /** Relative paths resolve against it. */
    readonly projectRoot: string;
}

/** The units of every target, and what went wrong expanding them. */
export interface ExpandResult {
    readonly units: CompileUnit[];
    readonly problems: CompileProblem[];
}

/** A target's name: its id, or its index. */
export function targetName(target: Pick<CompilationTarget, "id">, index: number): string {
    return target.id ?? String(index);
}

/**
 * Expands targets into units.
 *
 * @param only - The indexes of the targets to expand; default every one.
 */
export function expandTargets(settings: CompilationSettings, env: ExpandEnvironment, only?: ReadonlySet<number>): ExpandResult {
    const units: CompileUnit[] = [];
    const problems: CompileProblem[] = [];

    settings.targets.forEach((target, index) => {
        if (only !== undefined && !only.has(index)) {
            return;
        }

        const name = targetName(target, index);

        try {
            units.push(...expandTarget(settings, target, index, env, problems));
        } catch (error) {
            problems.push({ level: "error", message: error instanceof Error ? error.message : String(error), target: name });
        }
    });

    return { units: yieldToConfigTargets(units), problems };
}

/**
 * Drops the outputs a plugin's own target (a memory target's `CLAUDE.md`, say) would write over a
 * file a target from the project's config writes: the user's own target wins, so the two never
 * write the same file in turn. Recipe targets are left alone. A unit left with no outputs is dropped.
 *
 * ```ts
 * // the config builds CLAUDE.md from .sous/prompts/CLAUDE.md, plugin-memories adds memories/claude-code
 * yieldToConfigTargets(units);
 * // -> memories/claude-code is gone; the config's target writes CLAUDE.md alone
 * ```
 */
export function yieldToConfigTargets(units: readonly CompileUnit[]): CompileUnit[] {
    const fromConfig = new Set(
        units.filter((unit) => unit.origin === undefined).flatMap((unit) => unit.outputs.map((output) => output.destination)),
    );
    const yields = (unit: CompileUnit) => unit.origin?.plugin !== undefined && unit.origin.recipe === undefined;

    return units.flatMap((unit) => {
        if (!yields(unit) || !unit.outputs.some((output) => fromConfig.has(output.destination))) {
            return [unit];
        }

        const outputs = unit.outputs.filter((output) => !fromConfig.has(output.destination));

        return outputs.length === 0 ? [] : [{ ...unit, outputs }];
    });
}

function expandTarget(
    settings: CompilationSettings,
    target: CompilationTarget,
    index: number,
    env: ExpandEnvironment,
    problems: CompileProblem[],
): CompileUnit[] {
    const where = `compilation.targets[${index}]`;
    const name = targetName(target, index);
    const scopeKey = target.origin?.recipe;
    const scope = env.resolver.scope({ level: "target", target: index, ...(scopeKey === undefined ? {} : { scopeKey }) });
    const toPath = (value: string, context: string, inScope: VarScope = scope) =>
        path.resolve(env.projectRoot, env.resolver.normalizePath(env.resolver.substituteStrict(value, inScope, context)));
    const sources = [target.entryPoint, target.entryGlob, target.content].filter((source) => source !== undefined).length;

    if (sources !== 1) {
        throw new Error(`${where}: a target must have exactly one of 'entryPoint', 'entryGlob' or 'content'.`);
    }

    if (target.content !== undefined && target.id === undefined) {
        throw new Error(`${where}: a target whose source is 'content' needs an 'id', which names it in errors.`);
    }

    const base = {
        targetIndex: index,
        targetName: name,
        includeSourceComments: target.includeSourceComments ?? settings.includeSourceComments,
        scope,
        transforms: target.transforms ?? [],
        ...(target.origin === undefined ? {} : { origin: target.origin }),
    };
    const outputsFor = (unit: { source: string; globBase?: string }) => resolveOutputs(target, index, unit, env, scopeKey, toPath);

    if (target.content !== undefined) {
        const source = path.join(env.projectRoot, target.id!);
        const unit = { source, globBase: env.projectRoot };

        return [{ ...base, source, label: target.id!, content: target.content, globBase: env.projectRoot, outputs: outputsFor(unit) }];
    }

    if (target.entryPoint !== undefined) {
        const source = toPath(target.entryPoint, `${where}.entryPoint`);
        const globBase = target.globBase === undefined ? undefined : toPath(target.globBase, `${where}.globBase`);
        const unit = { source, ...(globBase === undefined ? {} : { globBase }) };

        return [{ ...base, source, label: source, ...(globBase === undefined ? {} : { globBase }), outputs: outputsFor(unit) }];
    }

    // A leading alias (`#project/skills/**`) gives one pattern per alias base; the first base
    // that matches any file wins, as the first existing candidate of an include does.
    const rawPattern = env.resolver.substituteStrict(target.entryGlob!, scope, `${where}.entryGlob`);
    const candidates = resolveAliasPrefix(env.resolver.normalizePath(rawPattern), env.aliases).map((candidate) =>
        path.resolve(env.projectRoot, candidate),
    );
    let pattern = candidates[0]!;
    let files: string[] = [];

    for (const candidate of candidates) {
        const matches = expandPattern(env.globs, candidate, { dot: false });

        if (matches.length > 0) {
            pattern = candidate;
            files = matches;
            break;
        }
    }

    if (files.length === 0) {
        problems.push({ level: "warning", message: `Glob pattern matched no files:\n${candidates.join("\n")}`, target: name });
    }

    const globBase = target.globBase === undefined ? path.resolve(env.globs.staticBase(pattern.split(path.sep).join("/"))) : toPath(target.globBase, `${where}.globBase`);

    return files.map((source) => ({ ...base, source, label: source, globBase, outputs: outputsFor({ source, globBase }) }));
}

/** A target's outputs for one source: `_if` applied, destinations substituted. */
function resolveOutputs(
    target: CompilationTarget,
    targetIndex: number,
    unit: { source: string; globBase?: string },
    env: ExpandEnvironment,
    scopeKey: string | undefined,
    toPath: (value: string, context: string, scope?: VarScope) => string,
): UnitOutput[] {
    const outputs: UnitOutput[] = [];

    target.outputs.forEach((output, index) => {
        const vars = env.resolver.scope({ level: "output", target: targetIndex, output: index, ...(scopeKey === undefined ? {} : { scopeKey }) });
        const where = `compilation.targets[${targetIndex}].outputs[${index}]`;

        if (output._if && !Object.entries(output._if).every(([name, condition]) => vars[name] === condition.eq)) {
            return;
        }

        const resolved = {
            ...(output.destinationFile === undefined ? {} : { destinationFile: toPath(output.destinationFile, `${where}.destinationFile`, vars) }),
            ...(output.destinationDir === undefined ? {} : { destinationDir: toPath(output.destinationDir, `${where}.destinationDir`, vars) }),
        };
        const destination = resolveOutputPath(unit, resolved);

        if (destination !== undefined) {
            outputs.push({ index, destination, vars, transforms: output.transforms ?? [] });
        }
    });

    return outputs;
}
