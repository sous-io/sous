/**
 * The contract of plugin-inspect: the built config and each contributor's changes, every plugin and what it
 * registered, and every timing. These intents read only the engine, so the plugin depends on none.
 * The intents return plain data; plugin-cli decides how it looks.
 *
 * Other plugins import this file type-only.
 */

import type { ConfigLayer, JsonObject, JsonValue, PluginInfo, TimingEntry } from "@sous-io/plugin-api";

/** One contributor's change to a value, for `--layers`. */
export interface LayerView extends ConfigLayer {
    /** The config file the contributor reads, from the `.sous` directory: `conf.d/610-mac.jsonc`. */
    readonly source?: string;
    /**
     * For `config get --layers`, when the change sets the value itself (or an object around it):
     * what the value was and became. A missing side means the value was not set.
     */
    readonly change?: { readonly from?: JsonValue; readonly to?: JsonValue };
    /** More a plugin explains about the change, such as a config file's expressions and what they read. */
    readonly annotations?: Readonly<Record<string, unknown>>;
}

/** One config file as written, for `--raw`. */
export interface RawConfigFile {
    readonly contributor: string;
    readonly path: string;
    readonly text: string;
}

/** `config.show`. */
export interface ConfigShowInput {
    /** Each contributor's changes, in order. */
    layers?: boolean;
    /** Each config file as written, in order. */
    raw?: boolean;
}

/** The result of `config.show`. */
export interface ConfigShowResult {
    /** The evaluated config: what sous does on this machine. */
    readonly config: JsonObject;
    readonly passes: number;
    readonly layers?: readonly LayerView[];
    readonly raw?: readonly RawConfigFile[];
}

/** `config.get`. */
export interface ConfigGetInput {
    /** The key path. */
    path: string;
    layers?: boolean;
    raw?: boolean;
}

/** The result of `config.get`. */
export interface ConfigGetResult {
    readonly path: string;
    readonly exists: boolean;
    readonly value: JsonValue | undefined;
    readonly passes: number;
    readonly layers?: readonly LayerView[];
    readonly raw?: readonly RawConfigFile[];
}

/** The result of `config.validate`. */
export interface ConfigValidateResult {
    readonly ok: boolean;
    /** One entry per problem, naming who set the value. */
    readonly issues: readonly string[];
    /** What was checked, for the summary. */
    readonly summary?: ConfigValidateSummary;
}

/** What `config.validate` checked. */
export interface ConfigValidateSummary {
    /** The main config file. */
    readonly configFile: string | undefined;
    /** How many config files were read: the main one and each `conf.d` file. */
    readonly layers: number;
    /** How many compilation targets the config holds. */
    readonly targets: number;
    /** The names of the configured tools. */
    readonly tools: readonly string[];
}

/** `plugins.show`. */
export interface PluginsShowInput {
    /** Only this plugin. */
    name?: string;
}

/** `timings.show`. */
export interface TimingsShowInput {
    /** Only entries over budget. */
    overBudget?: boolean;
    /** Only one category (`contributor`, `intent`). */
    category?: string;
}

declare module "@sous-io/plugin-api" {
    interface SousIntents {
        "config.show": { input: ConfigShowInput; result: ConfigShowResult };
        "config.get": { input: ConfigGetInput; result: ConfigGetResult };
        "config.validate": { input: Record<string, never>; result: ConfigValidateResult };
        "plugins.show": { input: PluginsShowInput; result: PluginInfo[] };
        "timings.show": { input: TimingsShowInput; result: TimingEntry[] };
    }
}
