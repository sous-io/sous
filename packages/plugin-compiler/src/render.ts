/**
 * The `compiler.targets` and `compiler.render` services: the config's targets expanded as the build
 * expands them, and one template rendered as the build renders it. Both read; neither writes.
 */

import fs from "node:fs";
import path from "node:path";
import { nullReporter } from "@sous-io/plugin-api";
import { CompileRun } from "./compiler.js";
import { runDependencies, selectTargets } from "./intents.js";
import type { CompilerRuntime } from "./runtime.js";
import { expandTargets, type CompileUnit, type ExpandResult } from "./targets.js";
import type {
    CompilationEntries,
    CompilerRender,
    CompilerTargets,
    CompileProblem,
    TemplateRenderRequest,
    TemplateRenderResult,
} from "./types.js";

/** The targets expanded into units, `only` keeping those targets (by id or index). */
function expandUnits(runtime: CompilerRuntime, only?: ReadonlyArray<string | number>): ExpandResult {
    const problems: CompileProblem[] = [];
    const selected = selectTargets(runtime, only, problems);
    const expanded = expandTargets(
        runtime.settings(),
        { resolver: runtime.resolver(), aliases: runtime.aliases(), globs: runtime.globs(), projectRoot: runtime.projectRoot() },
        selected,
    );

    return { units: expanded.units, problems: [...problems, ...expanded.problems] };
}

/** The `compiler.targets` service. */
export class TargetsService implements CompilerTargets {
    constructor(private readonly runtime: CompilerRuntime) {}

    expand(options: { targets?: ReadonlyArray<string | number> } = {}): CompilationEntries {
        const { units, problems } = expandUnits(this.runtime, options.targets);
        const entries = units.flatMap((unit) =>
            unit.outputs.map((output) => ({
                target: unit.targetName,
                targetIndex: unit.targetIndex,
                source: unit.source,
                ...(unit.content === undefined ? {} : { content: unit.content }),
                output: output.destination,
                outputIndex: output.index,
                transforms: [...unit.transforms, ...output.transforms],
                ...(unit.origin === undefined ? {} : { origin: unit.origin }),
            })),
        );

        return { entries, problems };
    }
}

/** The `compiler.render` service. */
export class RenderService implements CompilerRender {
    constructor(private readonly runtime: CompilerRuntime) {}

    async render(request: TemplateRenderRequest): Promise<TemplateRenderResult> {
        const file = path.resolve(this.runtime.projectRoot(), request.file);
        const { deps } = await runDependencies(this.runtime, this.runtime.source, nullReporter, false);
        const expanded = expandUnits(this.runtime, request.target === undefined ? undefined : [request.target]);

        if (request.target !== undefined && expanded.problems.some((problem) => problem.level === "error" && problem.target === undefined)) {
            return { text: request.source ?? "", problems: expanded.problems, included: [] };
        }

        const unit = this.unitFor(file, expanded.units, deps);
        const source = request.source ?? unit?.content ?? readSource(file);

        if (source === undefined) {
            return { text: "", problems: [{ level: "error", message: `File not found: ${file}`, file }], included: [] };
        }

        const output = unit === undefined ? undefined : (unit.outputs.find((candidate) => candidate.index === request.output) ?? unit.outputs[0]);
        const overrides = (request.scope ?? {}) as Record<string, string>;
        const base = output?.vars ?? unit?.scope ?? this.runtime.rootScope();
        const includeScope = { ...(unit?.scope ?? this.runtime.rootScope()), ...overrides };
        const run = new CompileRun(deps);
        const rendered = await run.renderFile({
            file,
            source,
            ...(unit === undefined ? {} : { unit }),
            vars: { ...base, ...overrides },
            includeScope,
        });

        return {
            ...rendered,
            ...(unit === undefined ? {} : { target: unit.targetName }),
            ...(output === undefined ? {} : { outputIndex: output.index }),
        };
    }

    /** The unit the file is the source of, else the first whose includes read it. */
    private unitFor(file: string, units: readonly CompileUnit[], deps: Awaited<ReturnType<typeof runDependencies>>["deps"]): CompileUnit | undefined {
        const own = units.find((unit) => unit.source === file);

        if (own !== undefined) {
            return own;
        }

        const wanted = new Set([file]);
        const probe = new CompileRun(deps);

        return units.find((unit) => probe.reads(unit, wanted));
    }
}

function readSource(file: string): string | undefined {
    try {
        return fs.readFileSync(file, "utf8");
    } catch {
        return undefined;
    }
}
