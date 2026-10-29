import type { Context } from "@sous-io/plugin-api";
import { watcherRunningError } from "../build.js";
import { projectLabel } from "../pid.js";
import type { BuildWatchInput, BuildWatchResult } from "../types.js";
import { WatchSession } from "./session.js";
import type { Timers, WatcherFactory } from "./watcher.js";

/** The signals that stop watch mode. */
export const STOP_SIGNALS = ["SIGINT", "SIGTERM"] as const;

/** Where stop signals come from: the process, or a stand-in in tests. */
export interface SignalSource {
    on(signal: (typeof STOP_SIGNALS)[number], listener: () => void): void;
    off(signal: (typeof STOP_SIGNALS)[number], listener: () => void): void;
}

/** The process's signals. */
export const processSignals: SignalSource = {
    on: (signal, listener) => {
        process.on(signal, listener);
    },
    off: (signal, listener) => {
        process.off(signal, listener);
    },
};

/** What the `build.watch` handler is built with. */
export interface WatchHandlerOptions {
    createWatcher: WatcherFactory;
    signals: SignalSource;
    timers?: Timers;
    /** Told about each session as it starts, so a front end or a test can stop it. */
    onSession?: (session: WatchSession) => void;
    /** Where relative paths resolve with no project. */
    cwd: () => string;
}

/**
 * The `build.watch` handler (background): records this process in the PID file, so a second
 * watcher on the project fails, then runs a {@link WatchSession} until a stop signal arrives or
 * something stops the session. The PID file is removed on the way out.
 */
export function createWatchHandler(options: WatchHandlerOptions) {
    return async (input: BuildWatchInput, ctx: Context): Promise<BuildWatchResult> => {
        const pid = ctx.services.get("build.pid");
        const recorded = pid.read();

        if (recorded !== undefined && recorded !== process.pid && pid.isRunning()) {
            throw watcherRunningError(projectLabel(ctx.project, pid.path()), recorded, pid.path());
        }

        pid.write();

        const session = new WatchSession({
            ctx,
            input,
            createWatcher: options.createWatcher,
            cwd: options.cwd(),
            ...(options.timers ? { timers: options.timers } : {}),
        });
        const onSignal = () => {
            void session.stop("signal");
        };

        for (const signal of STOP_SIGNALS) {
            options.signals.on(signal, onSignal);
        }

        try {
            try {
                await session.start();
            } catch (error) {
                await session.stop("error");

                throw error;
            }

            options.onSession?.(session);
            ctx.reporter.note("Watching for changes. Press Ctrl+C to stop.");

            return await session.done;
        } finally {
            for (const signal of STOP_SIGNALS) {
                options.signals.off(signal, onSignal);
            }

            pid.remove();
        }
    };
}
