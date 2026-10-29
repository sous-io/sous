import path from "node:path";
import type { Context } from "@sous-io/plugin-api";
import { pathsToWatch, type WatchSet, watchSet } from "./paths.js";
import { type ChangeBatch, ChangeBatcher, type FileWatcherHandle, realTimers, type Timers, type WatcherFactory } from "./watcher.js";
import { DEFAULT_DEBOUNCE_MS } from "../schemas.js";
import type { BuildWatchInput, BuildWatchResult } from "../types.js";

/** How often watch mode checks upstream when nothing says otherwise, as `store.watchPollSeconds` defaults. */
export const DEFAULT_POLL_SECONDS = 300;

/** What a {@link WatchSession} needs. */
export interface WatchSessionOptions {
    /** The background intent's context: `ctx.config` is always the latest config. */
    ctx: Context;
    input: BuildWatchInput;
    createWatcher: WatcherFactory;
    /** Where relative paths resolve with no project. */
    cwd: string;
    timers?: Timers;
}

/** A batch of changes, or a reason to rebuild everything. */
interface Trigger {
    files: string[];
    full: boolean;
    /** Why, when no file changed (upstream moved, a person asked). */
    reason?: string;
}

/**
 * One run of watch mode (C13): watches the sources of the latest config and submits a `build` (or
 * `compile`) chain for each batch of changes. Chains run one after another; changes that arrive
 * while one runs are gathered into the next.
 *
 * - A change to a source file is a partial rebuild: only the targets that include it compile, and
 *   nothing is prepared.
 * - A change to the config, `conf.d`, a linked checkout or a `watch.paths` entry is a full rebuild:
 *   the watcher stops, the config is rebuilt before the chain starts, and the watcher restarts on
 *   the new config. A config that fails to build is reported, the last good one stays, and the
 *   next save tries again.
 * - Every `pollSeconds`, `build.prepare` checks upstream; when it moves a pin, a full rebuild
 *   follows.
 */
export class WatchSession {
    /** Resolves when the session stops. */
    readonly done: Promise<BuildWatchResult>;

    private builds = 0;
    private failed = 0;
    private stopped = false;
    private busy: Promise<void> | undefined;
    private pending: Trigger | undefined;
    private watcher: FileWatcherHandle | undefined;
    private batcher: ChangeBatcher | undefined;
    private lastSet: WatchSet | undefined;
    private pollTimer: unknown;
    private resolveDone!: (result: BuildWatchResult) => void;
    private readonly timers: Timers;

    constructor(private readonly options: WatchSessionOptions) {
        this.timers = options.timers ?? realTimers;
        this.done = new Promise((resolve) => {
            this.resolveDone = resolve;
        });
    }

    private get ctx(): Context {
        return this.options.ctx;
    }

    /** Starts watching, and polling upstream when due. Throws when the first watch set cannot be worked out. */
    async start(): Promise<void> {
        await this.openWatcher(true);
        this.schedulePoll();
    }

    /** Rebuilds everything now, as a change to the config would, without waiting for the debounce. */
    trigger(reason: string): void {
        this.enqueue({ files: [], full: true, reason });
    }

    /** Stops watching; resolves {@link done} once the chain in progress, if any, has finished. */
    async stop(stoppedBy = "closed"): Promise<void> {
        if (this.stopped) {
            return;
        }

        this.stopped = true;
        this.pending = undefined;
        this.batcher?.cancel();

        if (this.pollTimer !== undefined) {
            this.timers.clearTimeout(this.pollTimer);
        }

        await this.closeWatcher();
        await this.busy;
        this.resolveDone({ builds: this.builds, failed: this.failed, stoppedBy });
    }

    // ------------------------------------------------------------------ the watcher

    private async openWatcher(first: boolean): Promise<void> {
        const ctx = this.ctx;
        const globs = ctx.services.get("host.globs");
        let set: WatchSet;

        try {
            set = watchSet(ctx.config, ctx.project, globs, { cwd: this.options.cwd, ignored: this.ignoredFiles() });
        } catch (error) {
            if (first || !this.lastSet) {
                throw error;
            }

            ctx.reporter.log("error", `Sous could not work out what to watch from the new config, so it keeps watching what it watched before.\n  ${message(error)}`);
            set = this.lastSet;
        }

        this.lastSet = set;

        const debounceMs = ctx.config.get("watch")?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
        const batcher = new ChangeBatcher(set, globs, debounceMs, (batch) => this.onBatch(batch), this.timers);
        const ignored = new Set(set.ignored.map((file) => path.resolve(file)));
        const paths = pathsToWatch(set, globs);

        this.batcher = batcher;
        this.watcher = await this.options.createWatcher(paths, { ignored: (file) => ignored.has(path.resolve(file)) }, (event, file) => batcher.handle(event, file));
        ctx.reporter.note(`Watching ${set.files.length + set.globs.length + set.fullRebuildPaths.length} pattern(s) for changes...`);
    }

    private async closeWatcher(): Promise<void> {
        const watcher = this.watcher;

        this.watcher = undefined;
        this.batcher?.cancel();
        await watcher?.close();
    }

    /** The state file and the PID file: written by builds and by watch mode itself. */
    private ignoredFiles(): string[] {
        const services = this.ctx.services;
        const files = [services.get("build.pid").path()];

        if (services.has("compiler.state")) {
            files.push(services.get("compiler.state").path());
        }

        return files;
    }

    // ------------------------------------------------------------------ the queue

    private onBatch(batch: ChangeBatch): void {
        this.enqueue({ files: batch.files, full: batch.full });
    }

    private enqueue(trigger: Trigger): void {
        if (this.stopped) {
            return;
        }

        this.pending = this.pending ? merge(this.pending, trigger) : trigger;

        if (!this.busy) {
            this.busy = this.drain().finally(() => {
                this.busy = undefined;
            });
        }
    }

    private async drain(): Promise<void> {
        while (this.pending && !this.stopped) {
            const trigger = this.pending;

            this.pending = undefined;
            await this.run(trigger);
        }
    }

    private async run(trigger: Trigger): Promise<void> {
        const ctx = this.ctx;

        await ctx.emit("build.files-changed", { files: trigger.files, full: trigger.full });

        if (trigger.full) {
            const why = trigger.reason ?? `Config changed (${trigger.files.join(", ")}), reloading settings and restarting watcher...`;

            ctx.reporter.note(why);
            await this.closeWatcher();
            ctx.configChanged();
        } else {
            ctx.reporter.note(`Change detected: ${trigger.files.join(", ")}`);
        }

        try {
            const result = await this.submitBuild(trigger.full ? undefined : trigger.files);

            this.builds += 1;

            if (!result.ok) {
                this.failed += 1;
            }
        } catch (error) {
            // A failed build has already said why; the watch keeps running so the next save can fix it.
            this.builds += 1;
            this.failed += 1;
            ctx.reporter.log(
                "error",
                trigger.full
                    ? `Config reload failed; keeping the last-good config. Fix the config and save again to retry.\n  ${message(error)}`
                    : `Rebuild failed: ${message(error)}`,
            );
        } finally {
            if (trigger.full && !this.stopped) {
                await this.openWatcher(false);
            }
        }
    }

    private submitBuild(changedFiles: string[] | undefined): Promise<{ ok: boolean }> {
        const { input } = this.options;
        const ctx = this.ctx;
        const flags = {
            ...(input.strict ? { strict: true } : {}),
            ...(input.rebuild ? { rebuild: true } : {}),
            ...(input.dryRun ? { dryRun: true } : {}),
            ...(changedFiles && !input.rebuild ? { changedFiles } : {}),
        };
        const io = { reporter: ctx.reporter, prompter: ctx.prompter, globals: ctx.globals };

        if (input.compileOnly) {
            return ctx.engine.submit({ intent: "compile", input: flags }, io);
        }

        return ctx.engine.submit({ intent: "build", input: { ...flags, ...(input.noPrune ? { noPrune: true } : {}) } }, io);
    }

    // ------------------------------------------------------------------ polling upstream

    /** Seconds between upstream checks: the input, then `watch.pollSeconds`, then `store.watchPollSeconds`. */
    pollSeconds(): number {
        if (this.options.input.compileOnly) {
            return 0;
        }

        const config = this.ctx.config;

        return this.options.input.pollSeconds ?? config.get("watch")?.pollSeconds ?? config.get("store")?.watchPollSeconds ?? DEFAULT_POLL_SECONDS;
    }

    private schedulePoll(): void {
        const seconds = this.pollSeconds();

        if (seconds <= 0 || this.stopped) {
            return;
        }

        this.pollTimer = this.timers.setTimeout(() => {
            void this.poll().finally(() => this.schedulePoll());
        }, seconds * 1000);
    }

    /**
     * Checks upstream through `build.prepare`. A failure never breaks the watch; the last good
     * answer stands.
     */
    async poll(): Promise<void> {
        if (this.stopped || this.busy) {
            return;
        }

        const ctx = this.ctx;

        try {
            const prepared = await ctx.engine.submit({ intent: "build.prepare", input: {} }, { reporter: ctx.reporter, prompter: ctx.prompter, globals: ctx.globals });

            if (prepared.locked.unchanged) {
                return;
            }

            const moved = prepared.locked.updated.map((change) => `  ${change.key} moved from ${change.from ?? "?"} to ${change.to ?? "?"}.`);

            this.trigger(["A newer recipe version arrived upstream.", ...moved].join("\n"));
        } catch (error) {
            ctx.reporter.warning(`Sous could not check upstream for newer recipes; it tries again in ${this.pollSeconds()} seconds.\n  ${message(error)}`);
        }
    }
}

function merge(first: Trigger, second: Trigger): Trigger {
    const files = [...first.files, ...second.files.filter((file) => !first.files.includes(file))];
    const reason = second.reason ?? first.reason;

    return { files, full: first.full || second.full, ...(reason === undefined ? {} : { reason }) };
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
