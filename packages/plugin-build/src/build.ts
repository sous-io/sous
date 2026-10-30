import fs from "node:fs";
import "@sous-io/plugin-memories/types";
import path from "node:path";
import { ConfigError, type Context, NotFoundError, SousError } from "@sous-io/plugin-api";
import type { CompileResult, CompilerPruneResult, WrittenFile } from "@sous-io/plugin-compiler/types";
import type { SkippedRecipe } from "@sous-io/plugin-recipes/types";
import { projectLabel } from "./pid.js";
import { NO_CHANGE, NOTHING_RESTORED } from "./prepare.js";
import { linkedReposMessage, prunedForSkippedLine, reportPrepared, skippedLine, unincludedMemoriesMessage } from "./report.js";
import type {
    BuildInput,
    BuildPrepareResult,
    BuildResult,
    BuildWatchInput,
    ClearInput,
    ClearResult,
    CompileCommandInput,
    CompileCommandResult,
    PruneInput,
} from "./types.js";

/**
 * `build`: the one build path (S6), used by `build`, `prune`, `launch`, `init` and every intent
 * that changes recipes. In order: announce linked repositories, prepare (`build.prepare`), report
 * what preparing did, write the runtime context file, compile (`compiler.compile`), prune
 * (`compiler.prune`), and say which locked recipes were skipped and what of theirs was pruned
 * (S4, 3). With `watch`, it then starts `build.watch`.
 *
 * A partial rebuild (`changedFiles`, from watch mode) prepares nothing: the config did not change,
 * so neither did the recipes it needs.
 */
export async function build(input: BuildInput, ctx: Context): Promise<BuildResult> {
    const dryRun = input.dryRun === true;
    const partial = (input.changedFiles?.length ?? 0) > 0 && input.rebuild !== true;

    if (input.watch) {
        ensureNoWatcher(ctx);
    }

    let prepared: BuildPrepareResult;

    if (partial) {
        prepared = nothingPrepared();
    } else {
        const linked = linkedReposMessage(ctx.services.get("recipes.links").all());

        if (linked) {
            ctx.reporter.warning(linked);
        }

        prepared = await ctx.run("build.prepare", { dryRun });
        reportPrepared(prepared, ctx.reporter);

        // The lockfile now pins other recipes: rebuild the config, so this build compiles them.
        if (!prepared.locked.unchanged && !dryRun) {
            if (ctx.chain && !ctx.chain.parallel) {
                await ctx.refreshConfig();
            } else {
                ctx.reporter.note("The lockfile changed while preparing; the recipes it now pins are compiled from the next build on.");
            }
        }
    }

    // What each skipped recipe had written, read before anything is removed.
    const skipped = partial ? [] : prepared.skipped;
    const skippedFiles = filesOfSkipped(ctx, skipped);

    let ok = true;
    let compiled: BuildResult["compiled"];
    let runtimeContext: WrittenFile | undefined;
    let cleared: CompilerPruneResult | undefined;

    if (!input.noCompile) {
        // --rebuild starts from a clean slate: everything written before is removed first.
        if (input.rebuild && !dryRun) {
            cleared = await ctx.run("compiler.prune", { all: true });
        }

        runtimeContext = await writeRuntimeContext(ctx, dryRun);
        compiled = await ctx.run("compiler.compile", {
            ...(input.strict ? { strict: true } : {}),
            ...(input.rebuild ? { rebuild: true } : {}),
            ...(dryRun ? { dryRun: true } : {}),
            ...(partial ? { changedFiles: input.changedFiles } : {}),
        });
        ok = compiled.ok;

        if (!partial) {
            warnUnincludedMemories(ctx, compiled);
        }
    }

    let pruned: CompilerPruneResult | undefined;

    if (!input.noPrune && ok) {
        pruned = await ctx.run("compiler.prune", { dryRun });
    }

    reportSkipped(ctx, skipped, skippedFiles, [...(cleared?.removed ?? []), ...(pruned?.removed ?? [])], dryRun);

    const watching = input.watch === true;

    if (watching) {
        startWatch(ctx, {
            ...(input.strict ? { strict: true } : {}),
            ...(input.rebuild ? { rebuild: true } : {}),
            ...(input.noPrune ? { noPrune: true } : {}),
            ...(dryRun ? { dryRun: true } : {}),
        });
    }

    return {
        ok,
        prepared,
        ...(compiled ? { compiled } : {}),
        ...(pruned ? { pruned } : {}),
        ...(runtimeContext ? { runtimeContext } : {}),
        dryRun,
        watching,
    };
}

/**
 * `compile`: compiles every target in the config without preparing recipes or pruning (S6). Recipe
 * targets are compiled too, since they are part of the config; what this leaves out is seeding,
 * locking, restoring and checking upstream.
 */
export async function compile(input: CompileCommandInput, ctx: Context): Promise<CompileCommandResult> {
    const dryRun = input.dryRun === true;
    const targets = ctx.config.get("compilation")?.targets ?? [];

    if (targets.length === 0) {
        throw new ConfigError(`No compilation config found in ${ctx.project?.configPath ?? "the config"}.`);
    }

    if (input.watch) {
        ensureNoWatcher(ctx);
    }

    const linked = linkedReposMessage(ctx.services.get("recipes.links").all());

    if (linked) {
        ctx.reporter.note(linked);
    }

    const runtimeContext = await writeRuntimeContext(ctx, dryRun);
    const partial = (input.changedFiles?.length ?? 0) > 0 && input.rebuild !== true;
    const compiled = await ctx.run("compiler.compile", {
        ...(input.strict ? { strict: true } : {}),
        ...(input.rebuild ? { rebuild: true } : {}),
        ...(dryRun ? { dryRun: true } : {}),
        ...(partial ? { changedFiles: input.changedFiles } : {}),
    });
    if (!partial) {
        warnUnincludedMemories(ctx, compiled);
    }

    const watching = input.watch === true;

    if (watching) {
        startWatch(ctx, {
            compileOnly: true,
            ...(input.strict ? { strict: true } : {}),
            ...(input.rebuild ? { rebuild: true } : {}),
            ...(dryRun ? { dryRun: true } : {}),
        });
    }

    return { ok: compiled.ok, compiled, ...(runtimeContext ? { runtimeContext } : {}), dryRun, watching };
}

/**
 * After a full compile that went cleanly, warns about memories no output read. Only a full compile
 * knows every route an include can take, so a partial one (watch mode) and a failed one say nothing.
 */
function warnUnincludedMemories(ctx: Context, compiled: CompileResult): void {
    if (!compiled.ok || compiled.included === undefined || !ctx.services.has("memories.selection")) {
        return;
    }

    const included = new Set(compiled.included);
    const missing = ctx.services
        .get("memories.selection")
        .selected()
        .filter((memory) => !included.has(realPath(memory.path)));
    const message = unincludedMemoriesMessage(missing);

    if (message !== undefined) {
        ctx.reporter.warning(message);
    }
}

/** The path with symbolic links resolved, or the path itself when it cannot be read. */
function realPath(file: string): string {
    try {
        return fs.realpathSync(file);
    } catch {
        return file;
    }
}

/**
 * `prune`: the build path with the compile step switched off. What counts as current depends on
 * the recipes the lockfile pins, so they are prepared first, or a recipe missing from the store
 * would have its outputs pruned as if it were gone.
 */
export async function prune(input: PruneInput, ctx: Context): Promise<CompilerPruneResult> {
    const dryRun = input.dryRun === true;
    const result = await ctx.run("build", { noCompile: true, ...(dryRun ? { dryRun: true } : {}) });

    return result.pruned ?? { removed: [], dirsRemoved: [], dryRun };
}

/**
 * `clear`: removes every file sous wrote for the project, after asking (`--force` answers ahead of
 * time, L4). The compiler removes them (`compiler.prune` with `all`), so linked checkouts and the
 * shared store stay protected.
 */
export async function clear(input: ClearInput, ctx: Context): Promise<ClearResult> {
    const dryRun = input.dryRun === true;
    const state = ctx.services.get("compiler.state");
    const stateFile = state.path();

    if (!fs.existsSync(stateFile)) {
        throw new NotFoundError("state file", stateFile, `No state file found at ${stateFile}. Run 'sous build' first, then 'sous clear' to recover.`);
    }

    const { files, dirs } = state.read();

    if (!input.force && !dryRun) {
        const confirmed = await ctx.prompter.confirm({
            message: `Delete ${files.length} file(s) and ${dirs.length} director(ies) for '${projectLabel(ctx.project, stateFile)}'?`,
            default: false,
            answeredBy: "--force",
        });

        if (!confirmed) {
            ctx.reporter.note("Aborted.");

            return { removed: [], dirsRemoved: [], dryRun, confirmed: false };
        }
    }

    const result = await ctx.run("compiler.prune", { all: true, ...(dryRun ? { dryRun: true } : {}) });

    return { ...result, confirmed: true };
}

/** The result of preparing nothing, for a partial rebuild. */
function nothingPrepared(): BuildPrepareResult {
    return { seeded: [], locked: NO_CHANGE, restored: NOTHING_RESTORED, newer: [], checkedUpstream: false, skipped: [], unanswered: [] };
}

/**
 * Writes the runtime context file when any compilation target asks for it, before anything
 * compiles. Says so when a target asks but no `runtimeContext` is set, or git cannot tell the branch.
 */
export async function writeRuntimeContext(ctx: Context, dryRun: boolean): Promise<WrittenFile | undefined> {
    const targets = ctx.config.get("compilation")?.targets ?? [];

    if (!targets.some((target) => target.generateRuntimeContext === true)) {
        return undefined;
    }

    const service = ctx.services.get("build.runtime-context");

    if (!service.settings()) {
        ctx.reporter.warning("A compilation target asks for the runtime context (generateRuntimeContext), but the config sets no runtimeContext, so none was written.");

        return undefined;
    }

    const generated = await service.generate();

    if (generated && generated.branch === undefined) {
        ctx.reporter.warning('Sous could not read the current git branch, so the runtime context says "unknown".');
    }

    const written = await service.write({ dryRun });

    await ctx.services.get("compiler.writer").commit({ dryRun });

    return written;
}

/** The built files of each skipped recipe, by key. */
function filesOfSkipped(ctx: Context, skipped: readonly SkippedRecipe[]): Map<string, Set<string>> {
    const files = new Map<string, Set<string>>();

    if (skipped.length === 0) {
        return files;
    }

    const state = ctx.services.get("compiler.state");

    for (const recipe of skipped) {
        files.set(recipe.key, new Set(state.filesFrom({ recipe: recipe.key }).map((entry) => path.resolve(entry.dest))));
    }

    return files;
}

/** One line per skipped recipe, and how many of its outputs were pruned (S4, 3). */
function reportSkipped(
    ctx: Context,
    skipped: readonly SkippedRecipe[],
    files: Map<string, Set<string>>,
    removedFiles: readonly string[],
    dryRun: boolean,
): void {
    const removed = new Set(removedFiles.map((file) => path.resolve(file)));

    for (const recipe of skipped) {
        const own = files.get(recipe.key) ?? new Set<string>();
        const count = [...own].filter((file) => removed.has(file)).length;

        ctx.reporter.note(count > 0 ? `${skippedLine(recipe)}\n${prunedForSkippedLine(count, dryRun)}` : skippedLine(recipe));
    }
}

/** Fails when a watcher already runs for this project, before anything is built. */
function ensureNoWatcher(ctx: Context): void {
    const pid = ctx.services.get("build.pid");
    const recorded = pid.read();

    if (recorded !== undefined && recorded !== process.pid && pid.isRunning()) {
        throw watcherRunningError(projectLabel(ctx.project, pid.path()), recorded, pid.path());
    }
}

/** The error for a second watcher on one project. */
export function watcherRunningError(label: string, pid: number, file: string): SousError {
    return new SousError(`A watcher is already running for project '${label}' (PID ${pid}). Stop it first or delete ${file}.`);
}

/**
 * Starts `build.watch` as a background intent: it runs outside the scheduler, so the chain that
 * started it finishes, and it submits a chain of its own for each change (S1, "Front Ends").
 */
function startWatch(ctx: Context, input: BuildWatchInput): void {
    ctx.engine
        .submit({ intent: "build.watch", input }, { reporter: ctx.reporter, prompter: ctx.prompter, globals: ctx.globals })
        .catch((error: unknown) => {
            ctx.reporter.log("error", `Watch mode stopped: ${error instanceof Error ? error.message : String(error)}`);
        });
}
