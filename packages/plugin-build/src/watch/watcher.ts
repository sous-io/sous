import type { HostGlobs } from "@sous-io/plugin-host/types";
import { classifyChange } from "./paths.js";
import type { WatchBatch, WatchedPaths } from "../types.js";

/** The events a file watcher reports that can change a build. */
export const RELEVANT_EVENTS: ReadonlySet<string> = new Set(["add", "change", "unlink"]);

/** A running file watcher. */
export interface FileWatcherHandle {
    close(): Promise<void>;
}

/** What a file watcher is started with. */
export interface FileWatcherOptions {
    ignored: (file: string) => boolean;
    /** Told about each error the watcher reports. */
    onError?: (error: unknown) => void;
}

/** Starts a file watcher on paths; `onEvent` gets every event (`add`, `change`, `unlink`, ...). */
export type WatcherFactory = (
    paths: readonly string[],
    options: FileWatcherOptions,
    onEvent: (event: string, file: string) => void,
) => Promise<FileWatcherHandle>;

/** The default watcher: chokidar, loaded only when something starts watching. */
export const chokidarWatcher: WatcherFactory = async (paths, options, onEvent) => {
    const { default: chokidar } = await import("chokidar");
    const watcher = chokidar.watch([...paths], { ignoreInitial: true, persistent: true, ignored: options.ignored });

    watcher.on("all", (event: string, file: string) => onEvent(event, file));
    watcher.on("error", (error: unknown) => options.onError?.(error));

    return { close: () => watcher.close() };
};

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

type Change = "changed" | "added" | "removed";

const CHANGE_OF_EVENT: Readonly<Record<string, Change>> = { add: "added", change: "changed", unlink: "removed" };

/**
 * Collects file events into batches: every relevant change within `debounceMs` of the last one
 * goes into one batch, handed to `onBatch` when the window closes. Files outside the watched paths
 * are ignored.
 *
 * A path seen more than once in a window keeps its latest change, except that an added file then
 * changed stays added, and a removed file then added again is changed.
 */
export class ChangeBatcher {
    private changes = new Map<string, Change>();
    private kinds = { sources: false, config: false, outputs: false };
    private timer: unknown;

    constructor(
        private readonly set: WatchedPaths,
        private readonly globs: HostGlobs,
        private readonly debounceMs: number,
        private readonly onBatch: (batch: WatchBatch) => void,
        private readonly timers: Timers = realTimers,
    ) {}

    /** Takes one event from the file watcher. */
    handle(event: string, file: string): void {
        const change = CHANGE_OF_EVENT[event];

        if (!RELEVANT_EVENTS.has(event) || change === undefined) {
            return;
        }

        const kind = classifyChange(file, this.set, this.globs);

        if (kind === "ignored") {
            return;
        }

        this.changes.set(file, merge(this.changes.get(file), change));

        if (kind === "source") this.kinds.sources = true;
        if (kind === "config") this.kinds.config = true;
        if (kind === "output") this.kinds.outputs = true;

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

        this.reset();
    }

    private reset(): void {
        this.changes = new Map();
        this.kinds = { sources: false, config: false, outputs: false };
    }

    private flush(): void {
        const entries = [...this.changes];
        const pick = (change: Change) => entries.filter(([, seen]) => seen === change).map(([file]) => file);
        const batch: WatchBatch = {
            files: entries.map(([file]) => file),
            changed: pick("changed"),
            added: pick("added"),
            removed: pick("removed"),
            ...this.kinds,
        };

        this.timer = undefined;
        this.reset();
        this.onBatch(batch);
    }
}

function merge(previous: Change | undefined, next: Change): Change {
    if (previous === "added" && next === "changed") return "added";
    if (previous === "removed" && next === "added") return "changed";

    return next;
}
