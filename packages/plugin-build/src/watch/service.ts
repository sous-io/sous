import path from "node:path";
import type { BuiltConfig, ProjectInfo, ServiceReader } from "@sous-io/plugin-api";
import { pathsToWatch, watchSet } from "./paths.js";
import { ChangeBatcher, type FileWatcherHandle, realTimers, type Timers, type WatcherFactory } from "./watcher.js";
import { DEFAULT_DEBOUNCE_MS } from "../schemas.js";
import type { BuildWatcher, WatchBatch, WatchHandle, WatchOptions } from "../types.js";

/** What the `build.watcher` service is made with. */
export interface WatcherServiceOptions {
    /** The config it watches for. */
    config: BuiltConfig;
    services: ServiceReader;
    project: ProjectInfo | undefined;
    /** Where relative paths resolve with no project, when `watch()` is given none. */
    cwd: string;
    createWatcher: WatcherFactory;
    timers?: Timers;
}

/**
 * The `build.watcher` service: works out what to watch from its config, starts one file watcher
 * for it, and hands each debounced batch to the caller. It never prints (L3): file watcher errors
 * go to `onError`.
 */
export class WatcherService implements BuildWatcher {
    constructor(private readonly options: WatcherServiceOptions) {}

    watch(options: WatchOptions, onChange: (batch: WatchBatch) => void): WatchHandle {
        const { config, services, project } = this.options;
        const globs = services.get("host.globs");
        const watching = watchSet(config, project, globs, {
            cwd: options.cwd ?? this.options.cwd,
            ignored: this.ignoredFiles(),
            ...(options.extra ? { extra: options.extra } : {}),
            ...(options.recipes ? { recipes: true } : {}),
            ...(options.outputs ? { outputs: this.outputs() } : {}),
        });
        const debounceMs = options.debounceMs ?? config.get("watch")?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
        const batcher = new ChangeBatcher(watching, globs, debounceMs, (batch) => onChange(batch), this.options.timers ?? realTimers);
        const ignored = new Set(watching.ignored.map((file) => path.resolve(file)));
        let closed = false;
        let closing: Promise<void> | undefined;

        const started: Promise<FileWatcherHandle> = this.options.createWatcher(
            pathsToWatch(watching, globs),
            {
                ignored: (file) => ignored.has(path.resolve(file)),
                ...(options.onError ? { onError: options.onError } : {}),
            },
            (event, file) => {
                if (!closed) batcher.handle(event, file);
            },
        );

        const close = (): Promise<void> => {
            if (closing) {
                return closing;
            }

            closed = true;
            batcher.cancel();
            options.signal?.removeEventListener("abort", onAbort);
            // A watcher that never started has nothing to close.
            closing = started.then(
                (handle) => handle.close(),
                () => undefined,
            );

            return closing;
        };
        const onAbort = () => void close();

        if (options.signal?.aborted) {
            void close();
        } else {
            options.signal?.addEventListener("abort", onAbort, { once: true });
        }

        return { watching, ready: started.then(() => undefined), close };
    }

    /** The state file and the PID file: written by builds and by watch mode itself. */
    private ignoredFiles(): string[] {
        const services = this.options.services;
        const files = [services.get("build.pid").path()];

        if (services.has("compiler.state")) {
            files.push(services.get("compiler.state").path());
        }

        return files;
    }

    /** Every output the state file records. */
    private outputs(): string[] {
        const services = this.options.services;

        return services.has("compiler.state") ? services.get("compiler.state").entries().map((entry) => entry.dest) : [];
    }
}
