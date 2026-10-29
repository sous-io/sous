import {
    BufferedReporter,
    type ContributorDefinition,
    definePlugin,
    jsonSchema,
    type PluginDefinition,
    type Sous,
} from "@sous-io/plugin-api";
import { createEngine, type Engine, type EngineOptions } from "../src/index.js";

/** A plugin that owns the given top-level config keys, with schemas that accept anything. */
export function keysPlugin(...keys: string[]): PluginDefinition {
    return definePlugin({
        name: "test-keys",
        version: "1.0.0",
        register(sous) {
            for (const id of keys) {
                sous.entities.add("config-key", { id, schema: jsonSchema({}) });
            }
        },
    });
}

/** A plugin from a register function. */
export function plugin(
    name: string,
    register: (sous: Sous) => void | Promise<void>,
    extra: Partial<PluginDefinition> = {},
): PluginDefinition {
    return definePlugin({ name, version: "1.0.0", ...extra, register });
}

/** A plugin that adds the given contributors. */
export function contributorsPlugin(name: string, contributors: ContributorDefinition[], extra: Partial<PluginDefinition> = {}): PluginDefinition {
    return plugin(
        name,
        (sous) => {
            for (const contributor of contributors) {
                sous.config.contribute(contributor);
            }
        },
        extra,
    );
}

/** An engine with a buffered reporter, so tests can read every message. */
export function makeEngine(builtIns: Array<PluginDefinition | string>, options: EngineOptions = {}): {
    engine: Engine;
    reporter: BufferedReporter;
} {
    const reporter = new BufferedReporter();

    return { engine: createEngine({ builtIns, reporter, ...options }), reporter };
}

/** The config without the keys core always fills in. */
export function userKeys(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const { plugins: _p, services: _s, intents: _i, budgets: _b, limits: _l, ...rest } = value;

    return rest;
}

/** A clock tests move by hand. */
export function manualClock(): { now: () => number; advance: (ms: number) => void } {
    let time = 0;

    return { now: () => time, advance: (ms) => (time += ms) };
}
