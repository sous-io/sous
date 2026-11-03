/**
 * The `compiler.targets` and `compiler.render` services: the config's targets expanded as the build
 * expands them, and one template rendered as the build renders it. Both read; neither writes.
 */

import fs from "node:fs";
import path from "node:path";
import { nullReporter, SousError } from "@sous-io/plugin-api";
import { CompileRun } from "./compiler.js";
import { expandUnits, runDependencies } from "./intents.js";
import type { CompilerRuntime } from "./runtime.js";
import { createTokenCounter, type TokenCounter } from "./tokens.js";
import type { CompileUnit } from "./targets.js";
import type {
    CompilationEntries,
    CompilerRender,
    CompilerTargets,
    CompileProblem,
    TemplateRenderRequest,
    TemplateRenderResult,
} from "./types.js";

/** The targets expanded into units, exactly as `compiler.compile` expands them, with every problem. */
function expandAll(runtime: CompilerRuntime, only?: ReadonlyArray<string | number>): { units: CompileUnit[]; problems: CompileProblem[] } {
    const expanded = expandUnits(runtime, only);

    return { units: expanded.units, problems: [...expanded.selectionProblems, ...expanded.problems] };
}

/** The `compiler.targets` service. */
export class TargetsService implements CompilerTargets {
    constructor(private readonly runtime: CompilerRuntime) {}

    expand(options: { targets?: ReadonlyArray<string | number> } = {}): CompilationEntries {
        const { units, problems } = expandAll(this.runtime, options.targets);
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
    /** The token counter, loaded on the first count and kept for the next. */
    private counter: Promise<TokenCounter> | undefined;

    constructor(private readonly runtime: CompilerRuntime) {}

    async countTokens(text: string): Promise<number> {
        // The encoder loads on its first count, so an empty count here loads it or fails.
        this.counter ??= createTokenCounter().then((counter) => {
            counter.count("");

            return counter;
        });

        let counter: TokenCounter;

        try {
            counter = await this.counter;
        } catch (error) {
            // Not kept, so a later count tries again.
            this.counter = undefined;

            throw new SousError("Cannot count tokens: the token counter (tiktoken) did not load.", {
                cause: error,
                details: [error instanceof Error ? error.message : String(error)],
            });
        }

        return counter.count(text);
    }

    async render(request: TemplateRenderRequest): Promise<TemplateRenderResult> {
        const file = path.resolve(this.runtime.projectRoot(), request.file);
        const { deps } = await runDependencies(this.runtime, this.runtime.source, nullReporter, false);
        const expanded = expandAll(this.runtime, request.target === undefined ? undefined : [request.target]);

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
