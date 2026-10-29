import type { JsonObject } from "@sous-io/plugin-api";

/**
 * The loop-detection limits (S1, "Finding Loops"). They are first guesses; a project changes them
 * under the `limits` config key (C51).
 */
export interface Limits {
    /** Passes one config stage may take before the config is said not to settle. */
    configPasses: number;
    /** Rebuilds in a row, each producing a new config. */
    rebuildsChanging: number;
    /** Rebuilds in a row that produce a config already seen in the streak (same hash). */
    rebuildsRepeating: number;
    /** `ctx.run` calls nested inside each other. */
    runDepth: number;
    /** The same intent, with the same input, nested inside its own call. */
    sameIntentDepth: number;
    /** The same event emitted again while its own listeners are still running. */
    eventDepth: number;
}

/** The default limits. */
export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
    configPasses: 10,
    rebuildsChanging: 10,
    rebuildsRepeating: 5,
    runDepth: 32,
    sameIntentDepth: 2,
    eventDepth: 5,
});

/** The limits in effect: the defaults, under any set in the config's `limits` key. */
export function resolveLimits(base: Readonly<Limits>, fromConfig: JsonObject | undefined): Limits {
    const limits: Limits = { ...base };

    for (const key of Object.keys(limits) as Array<keyof Limits>) {
        const value = fromConfig?.[key];

        if (typeof value === "number" && value > 0) {
            limits[key] = value;
        }
    }

    return limits;
}
