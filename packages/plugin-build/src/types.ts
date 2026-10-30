/**
 * The contract of plugin-build: the one build path every front end and
 * every other intent uses (`build`), compiling without recipes (`compile`), preparing for a build,
 * `prune` and `clear`, watch mode, the PID file and the runtime context file. It only runs intents;
 * every file it writes goes through `compiler.writer`.
 *
 * Other plugins import this file type-only.
 */

import type { CompileResult, CompilerPruneResult, WrittenFile } from "@sous-io/plugin-compiler/types";
import type { DefinedVariable } from "@sous-io/plugin-recipe-answers/types";
import type { LockDiff, RestoreReport, SkippedRecipe } from "@sous-io/plugin-recipes/types";

// ---------------------------------------------------------------------------------------------
// Config keys: watch, runtimeContext
// ---------------------------------------------------------------------------------------------

/** The `watch` config key, defaults filled in. */
export interface WatchSettings {
    /** How often watch mode checks upstream for newer recipes, in seconds; `0` never. Default: `store.watchPollSeconds`. */
    pollSeconds?: number;
    /** More files, directories or globs whose change triggers a full rebuild. Default `[]`. */
    paths: string[];
    /** How long to wait for more changes before building, in milliseconds. Default 200. */
    debounceMs: number;
}

/** The `runtimeContext` config key: the session context file a target may ask for. */
export interface RuntimeContextSettings {
    /** The git repository branch detection reads (`${var}` allowed). */
    gitRoot: string;
    /** Where the context file is written. */
    outputPath: string;
    /** The directory task files live in; the branch name is appended to find the active one. */
    taskFileRoot: string;
    /** A regular expression; only matching branches look for a task file. */
    branchPattern?: string;
}

// ---------------------------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------------------------

/** The watcher's PID file. */
export interface BuildPid {
    /** Where it is (`_vars.pidFilePath`, or `.sous/sous.pid` as before the refactor). */
    path(): string;
    /** The PID recorded, or `undefined`. */
    read(): number | undefined;
    /** Records a PID; default this process's. */
    write(pid?: number): void;
    remove(): void;
    /** Whether the recorded process is still running. */
    isRunning(): boolean;
}

/** The facts the runtime context file holds. */
export interface RuntimeContext {
    readonly branch?: string;
    /** The active task file, when the branch matches. */
    readonly taskFile?: string;
    readonly outputPath: string;
    /** The file's content. */
    readonly content: string;
}

/** The runtime context file: git branch and task file. */
export interface BuildRuntimeContext {
    /** The settings in force, `${var}` substituted, or `undefined` when none are set. */
    settings(): RuntimeContextSettings | undefined;
    /** Works out the context, writing nothing. */
    generate(): Promise<RuntimeContext | undefined>;
    /** Writes the file through `compiler.writer`. */
    write(options?: { dryRun?: boolean }): Promise<WrittenFile | undefined>;
}

// ---------------------------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------------------------

/** `build.prepare` (internal): seed core, lock new subscriptions, restore, check upstream. */
export interface BuildPrepareInput {
    dryRun?: boolean;
    /** Never goes upstream. */
    offline?: boolean;
}

/** The result of `build.prepare`; reported by events, shown by the front end. */
export interface BuildPrepareResult {
    /** Core recipes seeded into the store. */
    readonly seeded: string[];
    /** What locking new subscriptions changed. */
    readonly locked: LockDiff;
    readonly restored: RestoreReport;
    /** Newer in-range versions found upstream, not installed. */
    readonly newer: ReadonlyArray<{ readonly key: string; readonly from: string; readonly to: string }>;
    readonly checkedUpstream: boolean;
    /** Locked recipes not built on this machine, and why. */
    readonly skipped: SkippedRecipe[];
    /** One finished sentence per entry of `skipped`, in the same order (`skippedLine`), for front ends that list them. */
    readonly skippedLines: readonly string[];
    /** Required variables with no answer. */
    readonly unanswered: readonly DefinedVariable[];
    /** The finished warning about `unanswered`, or `undefined` when everything is answered. */
    readonly unansweredWarning?: UnansweredWarning;
}

/** The warning for required variables nothing answered. */
export interface UnansweredWarning {
    readonly title: string;
    /** One entry per variable, with the recipe that asks it. */
    readonly items: readonly string[];
    /** What to do about it. */
    readonly footer: string;
}

/** `build`: the one build path. */
export interface BuildInput {
    /** Leaves outputs no target produces any more. */
    noPrune?: boolean;
    /** Prepares only, compiling nothing. */
    noCompile?: boolean;
    /** Writes every output, changed or not. */
    rebuild?: boolean;
    dryRun?: boolean;
    /** Warnings fail the build. */
    strict?: boolean;
    /** Keeps building on every change (starts `build.watch`). */
    watch?: boolean;
    /**
     * Only the targets whose sources include one of these files, preparing nothing (watch mode's
     * partial rebuild). Agent addition: watch mode needs a way to ask for one.
     */
    changedFiles?: string[];
}

/** The result of `build`. */
export interface BuildResult {
    readonly ok: boolean;
    readonly prepared: BuildPrepareResult;
    readonly compiled?: CompileResult;
    readonly pruned?: CompilerPruneResult;
    readonly runtimeContext?: WrittenFile;
    readonly dryRun: boolean;
    /** True when watch mode was started. */
    readonly watching: boolean;
}

/** `compile`: compiling without recipes. */
export interface CompileCommandInput {
    strict?: boolean;
    rebuild?: boolean;
    dryRun?: boolean;
    watch?: boolean;
    /** Only the targets whose sources include one of these files (agent addition, as on `build`). */
    changedFiles?: string[];
}

/** The result of `compile`. */
export interface CompileCommandResult {
    readonly ok: boolean;
    readonly compiled: CompileResult;
    readonly runtimeContext?: WrittenFile;
    readonly dryRun: boolean;
    readonly watching: boolean;
}

/** `prune`. */
export interface PruneInput {
    dryRun?: boolean;
}

/** `clear`: removes every file sous wrote for the project. */
export interface ClearInput {
    /** Removes without asking (`--force`, `-f`, `--yes`). */
    force?: boolean;
    dryRun?: boolean;
}

/** The result of `clear`. */
export interface ClearResult extends CompilerPruneResult {
    /** False when the person declined. */
    readonly confirmed: boolean;
}

/** `build.watch` (background): submits a `build` (or `compile`) chain for each change. */
export interface BuildWatchInput {
    /** Submits `compile` chains instead of `build` ones. */
    compileOnly?: boolean;
    strict?: boolean;
    /** Overrides `watch.pollSeconds`. */
    pollSeconds?: number;
    /**
     * Agent addition: the flags of the `build` or `compile` that started watch mode, passed on to
     * every chain it submits, as before the refactor.
     */
    rebuild?: boolean;
    noPrune?: boolean;
    dryRun?: boolean;
}

/** The result of `build.watch`, when it stops. */
export interface BuildWatchResult {
    /** How many chains it submitted. */
    readonly builds: number;
    readonly failed: number;
    /** Why it stopped: `signal`, `closed`. */
    readonly stoppedBy: string;
}

/** The payload of `build.files-changed`: watch mode saw changes and is about to build. */
export interface BuildFilesChangedPayload {
    readonly files: readonly string[];
    /** True for a change that needs a full rebuild (the config, a template directory). */
    readonly full: boolean;
}

declare module "@sous-io/plugin-api" {
    interface SousServices {
        "build.pid": BuildPid;
        "build.runtime-context": BuildRuntimeContext;
    }

    interface SousIntents {
        build: { input: BuildInput; result: BuildResult };
        compile: { input: CompileCommandInput; result: CompileCommandResult };
        "build.prepare": { input: BuildPrepareInput; result: BuildPrepareResult };
        prune: { input: PruneInput; result: CompilerPruneResult };
        clear: { input: ClearInput; result: ClearResult };
        "build.watch": { input: BuildWatchInput; result: BuildWatchResult };
    }

    interface SousEvents {
        /** Preparing for a build finished. */
        "build.prepared": BuildPrepareResult;
        /** Watch mode saw changes. */
        "build.files-changed": BuildFilesChangedPayload;
    }

    interface SousConfig {
        watch: WatchSettings;
        runtimeContext: RuntimeContextSettings;
    }
}
