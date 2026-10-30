/**
 * The `compiler.compile` and `compiler.prune` intents (internal): compiling every target, and
 * removing outputs no target produces any more (or, for `clear`, every output).
 */

import path from "node:path";
import { LogLevel, nullReporter, type Context, type Reporter } from "@sous-io/plugin-api";
import type { LiquidEngines } from "@sous-io/plugin-liquid/types";
import type { RefsParser } from "@sous-io/plugin-refs/types";
import type { VariablesSecrets } from "@sous-io/plugin-variables/types";
import { CompileRun, type EngineRequest } from "./compiler.js";
import { createRenderFs } from "./liquid/render-fs.js";
import type { CompilerRuntime } from "./runtime.js";
import { isProtectedPath } from "./state.js";
import { expandTargets, targetName, type CompileUnit } from "./targets.js";
import { createTokenCounter } from "./tokens.js";
import type {
    CompileInput,
    CompileProblem,
    CompileResult,
    CompilerIncludes,
    CompilerPruneInput,
    CompilerPruneResult,
    StateFileEntry,
} from "./types.js";

/** Which target indexes `targets` names, by id or index; names that match nothing are problems. */
function selectTargets(runtime: CompilerRuntime, wanted: ReadonlyArray<string | number> | undefined, problems: CompileProblem[]): Set<number> | undefined {
    if (wanted === undefined) {
        return undefined;
    }

    const targets = runtime.settings().targets;
    const selected = new Set<number>();

    for (const name of wanted) {
        const index = typeof name === "number" ? name : targets.findIndex((target, i) => targetName(target, i) === name);

        if (index < 0 || index >= targets.length) {
            problems.push({ level: "error", message: `There is no compilation target "${name}".` });
            continue;
        }

        selected.add(index);
    }

    return selected;
}

/** Everything a compile run needs, from the runtime and the services in force. */
async function runDependencies(runtime: CompilerRuntime, ctx: Pick<Context, "services">, reporter: Reporter, countTokens: boolean) {
    const services = ctx.services;
    const includes: CompilerIncludes = services.get("compiler.includes");
    const liquid: LiquidEngines = services.get("liquid.engine");
    const secretNames = services.has("variables.secrets") ? [...(services.get("variables.secrets") as VariablesSecrets).declared()] : [];
    const counter = countTokens ? await createTokenCounter().catch(() => undefined) : undefined;
    const tracked = new Map<string, StateFileEntry>(services.get("compiler.state").entries().map((entry) => [path.resolve(entry.dest), entry]));

    return {
        counter,
        deps: {
            includes,
            hasNamespaceResolver: runtime.namespaceResolver() !== undefined,
            createEngine: (request: EngineRequest) =>
                liquid.create({
                    purpose: "template",
                    fs: createRenderFs({ includes, scope: request.scope, fromFile: request.fromFile }),
                    root: request.roots,
                    secretNames,
                    data: { fromFile: request.fromFile, scope: request.scope },
                    liquid: { extname: "", strictVariables: false, strictFilters: false },
                }),
            writer: services.get("compiler.writer"),
            tracked,
            transform: (id: string) => runtime.source.entities.get("compilation-transform", id),
            serviceContext: runtime.serviceContext,
            secretNames,
            reporter,
            ...(counter ? { countTokens: (text: string) => counter.count(text) } : {}),
            ...(services.has("refs.parser") ? { refsParser: services.get("refs.parser") as RefsParser } : {}),
            projectRoot: runtime.projectRoot(),
        },
    };
}

/** Reports the problems expanding the targets found, warnings as errors in strict mode. */
function reportExpansion(problems: CompileProblem[], strict: boolean, reporter: Reporter): CompileProblem[] {
    return problems.map((problem) => {
        const level = strict ? "error" : problem.level;

        reporter.problem(problem.message, {}, level === "error" ? LogLevel.Error : LogLevel.Warning);

        return { ...problem, level };
    });
}

/** Runs `compiler.compile`. */
export async function compile(input: CompileInput, ctx: Context, runtime: CompilerRuntime): Promise<CompileResult> {
    const started = performance.now();
    const strict = input.strict ?? false;
    const dryRun = input.dryRun ?? false;
    const store = runtime.store();

    store.refresh();

    const selectionProblems: CompileProblem[] = [];
    const only = selectTargets(runtime, input.targets, selectionProblems);
    const expanded = expandTargets(
        runtime.settings(),
        { resolver: runtime.resolver(), aliases: runtime.aliases(), globs: runtime.globs(), projectRoot: runtime.projectRoot() },
        only,
    );
    const problems = [...reportExpansion(selectionProblems, false, ctx.reporter), ...reportExpansion(expanded.problems, strict, ctx.reporter)];
    const { deps, counter } = await runDependencies(runtime, ctx, ctx.reporter, true);
    const run = new CompileRun(deps, { strict, ...(input.rebuild ? { rebuild: true } : {}), dryRun });
    let units: CompileUnit[] = expanded.units;

    if (input.changedFiles !== undefined) {
        const changed = new Set(input.changedFiles.map((file) => path.resolve(runtime.projectRoot(), file)));

        units = units.filter((unit) => run.reads(unit, changed));

        if (units.length === 0) {
            ctx.reporter.detail(`No targets affected by change to ${input.changedFiles.join(", ")}; nothing compiled`);
        }
    }

    try {
        const result = await run.run(units);
        const allProblems = [...problems, ...result.problems];
        const errors = allProblems.filter((problem) => problem.level === "error").length;

        await ctx.services.get("compiler.writer").commit({ dryRun });

        if (input.targets === undefined && input.changedFiles === undefined) {
            runtime.produced = result.produced;
        }

        ctx.reporter.operationEnd(errors > 0 ? `Done with ${errors} error(s).` : "Done.", errors === 0);
        await ctx.emit("compiler.wrote", { files: result.outputs, dryRun });

        return {
            ok: errors === 0 && (!strict || allProblems.every((problem) => problem.level !== "warning")),
            outputs: result.outputs,
            problems: allProblems,
            included: [...result.included],
            durationMs: performance.now() - started,
        };
    } finally {
        counter?.free();
    }
}

/** Every file the targets would write now: from the latest full compile, or a quiet dry run. */
async function producedNow(runtime: CompilerRuntime, ctx: Context): Promise<ReadonlySet<string>> {
    if (runtime.produced) {
        return runtime.produced;
    }

    const expanded = expandTargets(runtime.settings(), {
        resolver: runtime.resolver(),
        aliases: runtime.aliases(),
        globs: runtime.globs(),
        projectRoot: runtime.projectRoot(),
    });
    const { deps } = await runDependencies(runtime, ctx, nullReporter, false);
    const result = await new CompileRun(deps, { dryRun: true }).run(expanded.units);

    return result.produced;
}

/** Whether a plugin wrote the file through the writer itself: it names a plugin, and no target. */
function isDirectWrite(entry: StateFileEntry): boolean {
    return entry.target === undefined && entry.origin?.plugin !== undefined;
}

/** Runs `compiler.prune`. */
export async function prune(input: CompilerPruneInput, ctx: Context, runtime: CompilerRuntime): Promise<CompilerPruneResult> {
    const dryRun = input.dryRun ?? false;
    const store = runtime.store();

    store.refresh();

    const entries = ctx.services.get("compiler.state").entries();
    const protectedRoots = runtime.protectedRoots();
    const keep = input.all ? new Set<string>() : await producedNow(runtime, ctx);
    // A file a plugin wrote through the writer itself, not through a target (the runtime context
    // file), is that plugin's: a prune leaves it, and only clearing (`all`) removes it.
    const candidates = entries
        .filter((entry) => input.all || !isDirectWrite(entry))
        .map((entry) => path.resolve(entry.dest))
        .filter((dest) => !keep.has(dest) && !isProtectedPath(dest, protectedRoots));
    const writer = ctx.services.get("compiler.writer");
    const { removed, dirsRemoved } = await writer.remove(candidates, { dryRun });

    for (const file of removed) {
        ctx.reporter.operation(dryRun ? "would-remove" : "removed", file);
    }

    if (!dryRun) {
        if (input.all) {
            store.delete();
        } else {
            await writer.commit();
        }
    }

    await ctx.emit("compiler.pruned", { removed, dryRun });

    return { removed, dirsRemoved, dryRun };
}
