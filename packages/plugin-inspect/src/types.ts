/**
 * The contract of plugin-inspect (S6, "Showing the engine's state"; S2, "What `sous config show`
 * and `get` Print"): the built config and each contributor's changes, every plugin and what it
 * registered, and every timing. These intents read only the engine, so the plugin depends on none.
 * The intents return plain data; plugin-cli decides how it looks.
 *
 * Other plugins import this file type-only.
 */

import type { ConfigLayer, JsonObject, JsonValue, PluginInfo, TimingEntry } from "@sous-io/plugin-api";

/** One contributor's change to a value, for `--layers` (C53, C78). */
export interface LayerView extends ConfigLayer {
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
    /** One line per problem, naming who set the value. */
    readonly issues: readonly string[];
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
