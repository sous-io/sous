import type { HostGlobs } from "@sous-io/sous-plugin-host/types";
import { changesListing, classifyChange, type WatchSet } from "./paths.js";

/** The events a file watcher reports that can change an output. */
export const RELEVANT_EVENTS: ReadonlySet<string> = new Set(["add", "change", "unlink"]);

/** A running file watcher. */
export interface FileWatcherHandle {
    close(): Promise<void>;
}

/** Starts a file watcher on paths; `onEvent` gets every event (`add`, `change`, `unlink`, ...). */
export type WatcherFactory = (
    paths: readonly string[],
    options: { ignored: (file: string) => boolean },
    onEvent: (event: string, file: string) => void,
) => Promise<FileWatcherHandle>;

/** The default watcher: chokidar, loaded only when watch mode starts. */
export const chokidarWatcher: WatcherFactory = async (paths, options, onEvent) => {
    const { default: chokidar } = await import("chokidar");
    const watcher = chokidar.watch([...paths], { ignoreInitial: true, persistent: true, ignored: options.ignored });

    watcher.on("all", (event: string, file: string) => onEvent(event, file));

    return { close: () => watcher.close() };
};

/** Changes collected over one debounce window. */
export interface ChangeBatch {
    /** Every changed file, in the order first seen. */
    files: string[];
    /** True when any of them needs a full rebuild. */
    full: boolean;
    /** Why it is a full rebuild, when only files added to or removed from a glob target's folder made it one. */
    reason?: string;
}

/** What the timers are: injectable for tests. */
export interface Timers {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

/** The process's own timers. */
export const realTimers: Timers = {
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Collects file events into batches: every relevant change within `debounceMs` of the last one
 * goes into one batch, handed to `onBatch` when the window closes. Files outside the watch set are
 * ignored; a change to a full-rebuild path makes the whole batch full.
 */
export class ChangeBatcher {
    private files: string[] = [];
    private full = false;
    /** Files added or removed under a glob target: they change the files the config lists. */
    private listed: string[] = [];
    /** Whether a change other than those made the batch full (the config, conf.d, a link). */
    private fullOtherwise = false;
    private timer: unknown;

    constructor(
        private readonly set: WatchSet,
        private readonly globs: HostGlobs,
        private readonly debounceMs: number,
        private readonly onBatch: (batch: ChangeBatch) => void,
        private readonly timers: Timers = realTimers,
    ) {}

    /** Takes one event from the file watcher. */
    handle(event: string, file: string): void {
        if (!RELEVANT_EVENTS.has(event)) {
            return;
        }

        const classified = classifyChange(file, this.set, this.globs);
        // A file added or removed under a glob target changes the files the config lists, so the
        // config is rebuilt, not only the outputs.
        const relists = classified === "partial" && changesListing(event, file, this.set, this.globs);
        const kind = relists ? "full" : classified;

        if (kind === "ignored") {
            return;
        }

        if (!this.files.includes(file)) {
            this.files.push(file);
        }

        if (relists && !this.listed.includes(file)) {
            this.listed.push(file);
        }

        this.full ||= kind === "full";
        this.fullOtherwise ||= kind === "full" && !relists;

        if (this.timer !== undefined) {
            this.timers.clearTimeout(this.timer);
        }

        this.timer = this.timers.setTimeout(() => this.flush(), this.debounceMs);
    }

    /** Drops anything collected and stops the timer. */
    cancel(): void {
        if (this.timer !== undefined) {
            this.timers.clearTimeout(this.timer);
            this.timer = undefined;
        }

        this.files = [];
        this.full = false;
        this.listed = [];
        this.fullOtherwise = false;
    }

    private flush(): void {
        const reason =
            this.listed.length > 0 && !this.fullOtherwise
                ? `Files were added or removed where a compilation target's glob looks (${this.listed.join(", ")}), so the config lists other files; reloading settings and restarting watcher...`
                : undefined;
        const batch: ChangeBatch = { files: this.files, full: this.full, ...(reason === undefined ? {} : { reason }) };

        this.timer = undefined;
        this.files = [];
        this.full = false;
        this.listed = [];
        this.fullOtherwise = false;
        this.onBatch(batch);
    }
}
