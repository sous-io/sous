import type {
    BuiltConfig,
    ChainInfo,
    Context,
    EngineHandle,
    Environment,
    EventPayload,
    JsonObject,
    Prompter,
    ProjectInfo,
    Reporter,
} from "@sous-io/plugin-api";
import type { BuiltConfigImpl } from "./config/built-config.js";
import type { Frame } from "./util/frames.js";

/** One chain, while it runs. */
export class ChainState implements ChainInfo {
    /** Set when anything in the chain changed the config. */
    changedConfig = false;

    constructor(
        readonly id: number,
        readonly intent: string,
        readonly parallel: boolean,
        /** The chain's config: the one it started with, until `ctx.refreshConfig()` replaces it. */
        public config: BuiltConfigImpl,
        readonly reporter: Reporter,
        readonly prompter: Prompter,
        readonly globals: Readonly<Record<string, unknown>>,
    ) {}
}

/**
 * Where a call is happening:
 * - `chain`: inside a chain; `ctx.run` runs in the same chain;
 * - `inline`: in a `config.built` listener; `ctx.run` runs a new chain at once;
 * - `detached`: outside any chain (a listener of an event a plugin fired on its own, an entity
 *   method); `ctx.run` submits a new chain;
 * - `background`: inside a background intent; `ctx.run` submits a new chain, and `ctx.config` is
 *   always the latest.
 */
export interface CallState {
    readonly mode: "chain" | "inline" | "detached" | "background";
    readonly chain: ChainState | undefined;
    readonly frame: Frame | undefined;
    /**
     * The config of the call outside a chain. Read it through {@link configOf}: a chain's config is
     * its chain's, and a background call's is the latest.
     */
    readonly config: BuiltConfigImpl;
    readonly reporter: Reporter;
    readonly prompter: Prompter;
    readonly globals: Readonly<Record<string, unknown>>;
    /** The working directory the front end gave, as `ctx.cwd`. */
    readonly cwd: string;
}

/** The config a call sees: its chain's (which `ctx.refreshConfig()` may replace), or the call's own. */
export function configOf(call: CallState, latest: () => BuiltConfigImpl): BuiltConfigImpl {
    if (call.mode === "background") {
        return latest();
    }

    return call.mode === "chain" && call.chain ? call.chain.config : call.config;
}

/** What a context needs from the engine. */
export interface CallHost {
    readonly handle: EngineHandle;
    readonly project: ProjectInfo | undefined;
    readonly env: Environment;
    latestConfig(): BuiltConfigImpl;
    run(intent: string, input: unknown, call: CallState): Promise<unknown>;
    emitCustom(name: string, payload: unknown, call: CallState): Promise<unknown>;
    /** Says the config must be rebuilt before the next chain (for calls outside a chain). */
    markConfigChanged(): void;
    /** Rebuilds the config for the rest of a series chain. */
    refreshConfig(call: CallState): Promise<BuiltConfig>;
}

/**
 * The `ctx` a handler, a listener, a wrapper or an entity method gets, for one plugin in one call.
 */
export function createContext(host: CallHost, call: CallState, plugin: string): Context {
    const config = (): BuiltConfigImpl => configOf(call, () => host.latestConfig());

    return {
        plugin,
        get config() {
            return config();
        },
        get entities() {
            return config().entities;
        },
        get services() {
            return config().services;
        },
        reporter: call.reporter,
        prompter: call.prompter,
        project: host.project,
        env: host.env,
        globals: call.globals,
        cwd: call.cwd,
        chain: call.chain,
        engine: host.handle,
        options<T = JsonObject>(): T | undefined {
            return config().get<T>(["plugins", "options", plugin]);
        },
        run: ((intent: string, input?: unknown) => host.run(intent, input, call)) as Context["run"],
        emit: ((name: string, payload?: EventPayload<string>) => host.emitCustom(name, payload, call)) as Context["emit"],
        refreshConfig: () => host.refreshConfig(call),
        configChanged(): void {
            if (call.chain) {
                call.chain.changedConfig = true;
            } else {
                host.markConfigChanged();
            }
        },
    };
}
