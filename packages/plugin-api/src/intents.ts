import type { Context } from "./context.js";
import type { Prompter } from "./prompter.js";
import type { IntentInput, IntentResult, SousIntents } from "./registry.js";
import type { Reporter } from "./reporter.js";
import type { InferOutput, SousSchema } from "./schema.js";

/** A handler: runs an intent and returns its result. */
export type IntentHandler<In = any, Result = unknown> = (input: In, ctx: Context) => Result | Promise<Result>;

/**
 * A wrapper changes what an intent's handler does. Wrappers stack in plugin order: the wrapper of
 * the plugin loaded last runs first and calls `next`, down to the handler.
 *
 * ```ts
 * sous.intents.wrap("build", (next) => async (input, ctx) => {
 *     const result = await next(input, ctx);
 *
 *     return { ...result, diagrams: await renderDiagrams(ctx) };
 * });
 * ```
 */
export type IntentWrapper<In = any, Result = unknown> = (next: IntentHandler<In, Result>) => IntentHandler<In, Result>;

/** How the CLI shows an intent (S1, "What an intent declares for the CLI and for agents"). */
export interface CliSection {
    /** The command words. Default: the intent's name split at dots (`namespace.list` → `namespace list`). */
    command?: readonly string[];
    /** More command words that run it, in any group (`["ns", "list"]`, `["list", "namespaces"]`). */
    aliases?: ReadonlyArray<readonly string[]>;
    /** Input fields given as positional arguments, in order. The last may be an array, taking the rest. */
    positional?: readonly string[];
    /** Example command lines for `--help`. */
    examples?: readonly string[];
    /** Keeps it out of help and suggestions; it still runs. */
    hidden?: boolean;
    /** Per input field: a one-letter short flag (`y` for `-y`), more flag names, or hiding it from help. */
    flags?: Readonly<Record<string, CliFlagOptions>>;
}

/** CLI options for one input field. */
export interface CliFlagOptions {
    /** A one-letter short form, without the dash. */
    short?: string;
    /** More long names, without the dashes. Shown in help only when not hidden. */
    aliases?: readonly string[];
    /** Keeps the flag out of `--help`. */
    hidden?: boolean;
}

/** How agents see an intent through MCP. */
export interface AgentSection {
    /** The tool name. Default: the intent's name with dots as underscores (`namespace_list`). */
    tool?: string;
    /** When and how to use it. */
    usage?: string;
    /** When not to use it, and what to use instead. */
    whenNotToUse?: string;
    /** Keeps it out of MCP. */
    hidden?: boolean;
}

/** The handler module an intent can load lazily, so `--help` never imports command code (G9). */
export type IntentHandlerModule<In, Result> =
    | IntentHandler<In, Result>
    | { default: IntentHandler<In, Result> }
    | { handle: IntentHandler<In, Result> };

/** The input type an intent's handler receives: the declared type, or the schema's output. */
export type IntentInputOf<N extends string, S> = N extends keyof SousIntents ? IntentInput<N> : InferOutput<S>;

/**
 * An intent: a step a user or another plugin asks for, with a typed input and one handler (S1,
 * "Intents"). The CLI's commands and flags and the MCP server's tools are generated from it.
 *
 * Give either `handle`, or `load` to import the handler only when the intent runs.
 */
export interface IntentDefinition<N extends string = string, S extends SousSchema = SousSchema> {
    /** The name, `<plugin>.<verb>`: `diagrams.render`, `subscription.add`. */
    intent: N;
    /** One sentence saying what it does, for help, tools and the web GUI. */
    summary?: string;
    /** More about it, for `--help`. */
    description?: string;
    /** The input schema. Every input is a flag (L4). Default: no input. */
    input?: S;
    /** The result schema, for front ends that describe results (MCP). */
    output?: SousSchema;
    /** Runs outside the scheduler, such as `mcp.serve`; it submits chains instead of using `ctx.run`. */
    background?: boolean;
    /** A chain started with this intent may run beside other parallel chains: it writes nothing others read. */
    parallel?: boolean;
    /** Running it changes the config, so the engine rebuilds the config before the next chain. */
    changesConfig?: boolean;
    /**
     * It can run when the config fails to build (`sous update` repairing a broken install): it runs
     * with whatever partial config the failed build reached (the plugins it activated, the values
     * it merged, unchecked), and the build's error is reported as a warning. Other intents fail
     * with that error.
     */
    toleratesConfigErrors?: boolean;
    /**
     * It works on a project, so it fails, before it runs, when sous was started outside one: the
     * error says no sous config was found and how to set a project up.
     */
    requiresProject?: boolean;
    /** Only callable through `ctx.run`; neither the CLI nor MCP shows it. */
    internal?: boolean;
    /** How the CLI shows it. */
    cli?: CliSection;
    /** How agents see it. */
    agent?: AgentSection;
    /** Runs the intent. */
    handle?: IntentHandler<IntentInputOf<N, S>, IntentResult<N>>;
    /** Imports the handler when the intent first runs. */
    load?: () => Promise<IntentHandlerModule<IntentInputOf<N, S>, IntentResult<N>>>;
}

/** An intent and the plugin that added it, as front ends see it. */
export interface IntentInfo {
    readonly definition: IntentDefinition;
    /** The plugin that added it. */
    readonly plugin: string;
}

/** What front ends read about the intents: every one that is loaded and active. */
export interface IntentCatalog {
    /** Every active intent, in plugin order. */
    list(): IntentInfo[];
    /** One intent, or `undefined`. */
    get(name: string): IntentInfo | undefined;
}

/** Asking the engine to run an intent. */
export interface IntentRequest<N extends string = string> {
    intent: N;
    input?: IntentInput<N> | Record<string, unknown>;
}

/** How a front end submits a chain. */
export interface SubmitOptions {
    /** Where the chain's output goes. Default: the engine's reporter. */
    reporter?: Reporter;
    /** Where the chain's questions go. Default: a prompter that cannot ask. */
    prompter?: Prompter;
    /** Declares the chain parallel. Default: what the intent declares. */
    parallel?: boolean;
    /** Values of the front end's global arguments (`--debug`, plugin-added ones), as `ctx.globals`. */
    globals?: Readonly<Record<string, unknown>>;
    /** The working directory, as `ctx.cwd` (the CLI: the process's; MCP: the project root). Default: the engine's. */
    cwd?: string;
}
