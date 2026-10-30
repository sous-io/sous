import type { BuildOptions, BuiltConfig } from "./config.js";
import type { EntityReader } from "./entities.js";
import type { EventFor, EventPayload } from "./events.js";
import type { IntentCatalog, IntentRequest, SubmitOptions } from "./intents.js";
import type { JsonObject } from "./json.js";
import type { Prompter } from "./prompter.js";
import type { IntentInput, IntentName, IntentResult } from "./registry.js";
import type { Reporter } from "./reporter.js";
import type { ServiceReader } from "./services.js";
import type { Timings } from "./timing.js";

/**
 * The project a sous process serves: the one found from its working directory. Its root is the
 * directory holding the `.sous/` directory the config file was found in.
 */
export interface ProjectInfo {
    /** The project root. */
    readonly root: string;
    /** The `.sous/` directory. */
    readonly sousDir: string;
    /** The config file, when one was found. */
    readonly configPath: string | undefined;
    /** The `conf.d` directory. */
    readonly confDir: string;
}

/** The environment variables sous was started with. Read them here, never from `process.env`. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** The application the engine runs: sous itself, or another tool built on the engine. */
export interface AppInfo {
    readonly name: string;
    readonly version: string;
}

/** The chain a context belongs to. */
export interface ChainInfo {
    /** Counts chains in this process. */
    readonly id: number;
    /** The intent the chain was submitted with. */
    readonly intent: string;
    readonly parallel: boolean;
}

/** One loaded plugin, as front ends and `plugins show` see it. */
export interface PluginInfo {
    readonly name: string;
    readonly version: string | undefined;
    /** Whether it is active in the current config. */
    readonly active: boolean;
    readonly builtIn: boolean;
    /** The plugin that brought it in, or `plugins.load`. */
    readonly loadedBy: string | undefined;
    /** What it registered, for `plugins show`. */
    readonly registrations: ReadonlyArray<{ readonly kind: string; readonly name: string }>;
    /** Its options from `plugins.options` in the current config, if any. */
    readonly options: JsonObject | undefined;
}

/**
 * The engine, as plugins see it: what front ends and background intents use.
 */
export interface EngineHandle {
    /** The config as of the latest rebuild. */
    readonly config: BuiltConfig;
    /** The application name and version. */
    readonly app: AppInfo;
    /** The intents front ends generate commands and tools from. */
    readonly intents: IntentCatalog;
    /** Every timing so far (`--timings`). */
    readonly timings: Timings;
    /** Where engine-level messages go (budget warnings, build warnings). */
    readonly reporter: Reporter;
    /**
     * The error of the latest config build, when it failed (`undefined` once one succeeds). The
     * config is then the partial one that build reached; only intents that declare
     * `toleratesConfigErrors` run, and a front end should report this error for anything else.
     */
    readonly configError: unknown;
    /** Sets where engine-level messages go; messages kept so far are sent there first. */
    setReporter(reporter: Reporter): void;
    /** Submits a chain; resolves with the intent's result. */
    submit<N extends IntentName>(request: IntentRequest<N>, options?: SubmitOptions): Promise<IntentResult<N>>;
    /** Builds a separate "what if" config, never replacing the real one. */
    buildConfig(options?: BuildOptions): Promise<BuiltConfig>;
    /** Every loaded plugin. */
    plugins(): PluginInfo[];
    /** Resolves when every background intent has returned. */
    whenBackgroundIntentsReturn(): Promise<void>;
}

/**
 * What a handler, a listener or an entity method gets (`ctx`). Inside a chain, `run` starts another
 * intent as part of the same chain.
 */
export interface Context {
    /** The plugin whose code was given this context. */
    readonly plugin: string;
    /** The config this chain started with (for a background intent, the latest). */
    readonly config: BuiltConfig;
    readonly entities: EntityReader;
    readonly services: ServiceReader;
    /** Where this chain's output goes: the front end that submitted it. */
    readonly reporter: Reporter;
    /** Where this chain's questions go: the front end that submitted it. */
    readonly prompter: Prompter;
    readonly project: ProjectInfo | undefined;
    readonly env: Environment;
    /** The front end's global argument values (`debug`, `logLevel`, plugin-added ones). */
    readonly globals: Readonly<Record<string, unknown>>;
    /**
     * The working directory the front end gave the chain: the CLI gives the process's, the MCP
     * server the project root. Use it instead of `process.cwd()`. Default: the engine's.
     */
    readonly cwd: string;
    /** The chain, or `undefined` outside one (a background intent). */
    readonly chain: ChainInfo | undefined;
    readonly engine: EngineHandle;
    /** This plugin's own options from `plugins.options`. */
    options<T = JsonObject>(): T | undefined;
    /**
     * Runs an intent as part of this chain, immediately, and returns its result. Outside a
     * chain it submits a new chain instead.
     */
    run<N extends IntentName>(intent: N, input?: IntentInput<N> | Record<string, unknown>): Promise<IntentResult<N>>;
    /** Fires an event and waits for every listener. */
    emit<N extends string>(name: N, payload?: EventPayload<N>): Promise<EventFor<N>>;
    /** Says this chain changed the config, so it is rebuilt before the next chain starts. */
    configChanged(): void;
    /**
     * Rebuilds the config now, for the rest of this chain: later `ctx.config`, `ctx.services`
     * (`config` services are made again), `ctx.entities` and `ctx.run` calls see the new one. The
     * new config becomes the engine's, and `config.built` fires, as for any rebuild. Resolves with
     * it; a failed build rejects, and the chain keeps its old config.
     *
     * Only a series chain may do this: a parallel chain, a background intent, a `config.built`
     * listener or code outside any chain gets a `SousError`.
     *
     * ```ts
     * async handle(input, ctx) {
     *     await writeSubscription(ctx, input);       // changes a config file
     *     await ctx.refreshConfig();                 // the build below sees it
     *
     *     return ctx.run("build", {});
     * }
     * ```
     */
    refreshConfig(options?: RefreshConfigOptions): Promise<BuiltConfig>;
}

/** Options for `ctx.refreshConfig()`. */
export interface RefreshConfigOptions {
    /**
     * Where to look for the project before rebuilding, for an intent that has just set one up
     * (`sous init`). The engine takes the project found at or above this directory when it differs
     * from the one it serves; without a project there, nothing changes.
     *
     * ```ts
     * await writeProjectFiles(root);
     * await ctx.refreshConfig({ locateProjectFrom: root });   // the build below serves `root`
     * ```
     */
    locateProjectFrom?: string;
}
