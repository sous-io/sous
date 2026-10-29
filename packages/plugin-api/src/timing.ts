/**
 * Timing and budgets (L5). Every core stage and every call into a plugin is timed, and each has a
 * budget, changeable under the `budgets` config key (`false` turns a warning off).
 */

/** What was timed. */
export type TimingCategory =
    | "config.build"
    | "config.stage"
    | "config.pass"
    | "config.validate"
    | "contributor"
    | "plugin.load"
    | "plugin.register"
    | "chain"
    | "intent"
    | "listener"
    | "service.create"
    | "service.method"
    | "entity.method";

/** Every timing category, for checks that each has a budget. */
export const TIMING_CATEGORIES: readonly TimingCategory[] = [
    "config.build",
    "config.stage",
    "config.pass",
    "config.validate",
    "contributor",
    "plugin.load",
    "plugin.register",
    "chain",
    "intent",
    "listener",
    "service.create",
    "service.method",
    "entity.method",
];

/** Everything timed under one key (`intent:build`, `contributor:confd/610-mac.jsonc`). */
export interface TimingEntry {
    /** `<category>:<name>`. */
    readonly key: string;
    readonly category: TimingCategory;
    readonly name: string;
    /** The plugin whose code ran, when it was plugin code. */
    readonly plugin: string | undefined;
    readonly count: number;
    readonly totalMs: number;
    readonly maxMs: number;
    /** The budget each call is held to, or `false` when its warning is off. */
    readonly budgetMs: number | false;
    /** How many calls went over budget. */
    readonly overBudget: number;
}

/** Reading timings. */
export interface Timings {
    /** Every entry, in the order first timed. */
    entries(): TimingEntry[];
    /** One entry, by key. */
    get(key: string): TimingEntry | undefined;
}
