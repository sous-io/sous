/**
 * Freshness: when sous bothers to look upstream. A repository is checked when it has never been
 * checked, when the freshness window has lapsed since the last check, or when a caller forces it.
 * A failed check never breaks a build; the index cache falls back to the copy it holds.
 */

import semver from "semver";
import type { IndexFile } from "@sous-io/plugin-formats/types";
import { DEFAULT_FRESHNESS_SECONDS, PROJECT_HOLDER } from "../constants.js";

/** What decides whether to look upstream. */
export interface FreshnessInput {
    /** When sous last asked upstream. */
    lastCheckedAt?: string;
    /** How long a check stays good, in seconds. Default 300. */
    freshnessSeconds?: number;
    /** Check regardless (`--latest`). */
    force?: boolean;
    now?: Date;
}

/**
 * True when sous should ask upstream whether there is anything newer.
 *
 * ```ts
 * shouldCheckUpstream({ lastCheckedAt: "2026-01-01T00:00:00.000Z", freshnessSeconds: 300 });
 * // false a minute later, true six minutes later
 * ```
 */
export function shouldCheckUpstream(input: FreshnessInput): boolean {
    if (input.force === true || input.lastCheckedAt === undefined) {
        return true;
    }

    const last = Date.parse(input.lastCheckedAt);

    if (Number.isNaN(last)) {
        return true;
    }

    const windowSeconds = input.freshnessSeconds ?? DEFAULT_FRESHNESS_SECONDS;

    if (windowSeconds <= 0) {
        return true;
    }

    const ageSeconds = ((input.now ?? new Date()).getTime() - last) / 1000;

    // A last check in the future means the clock changed under sous; check rather than trust it.
    return ageSeconds < 0 || ageSeconds >= windowSeconds;
}

/** A newer in-range version of a locked recipe. */
export interface NewerVersion {
    key: string;
    from: string;
    to: string;
}

/**
 * A newer version of a locked recipe that still satisfies its range, or `undefined`. It never
 * widens the range, so a dependency's constraint still holds.
 */
export function findNewerInRange(options: { index: IndexFile; key: string; lockedVersion: string; range?: string; prerelease?: boolean }): NewerVersion | undefined {
    const entry = options.index.recipes[options.key];

    if (entry === undefined) {
        return undefined;
    }

    const prerelease = options.prerelease ?? false;
    const candidates = Object.keys(entry.versions).filter((version) => {
        if (!prerelease && entry.versions[version].prerelease === true) {
            return false;
        }

        return semver.satisfies(version, options.range ?? "*", { includePrerelease: prerelease });
    });
    const best = semver.maxSatisfying(candidates, "*", { includePrerelease: prerelease });

    if (best === null || semver.valid(options.lockedVersion) === null || semver.lte(best, options.lockedVersion)) {
        return undefined;
    }

    return { key: options.key, from: options.lockedVersion, to: best };
}

/** How to read what each holder of a locked recipe declared. */
export interface DeclaredRangeLookup {
    /** The project's subscription range for a key, `*` when none, `undefined` when nothing holds it any more. */
    subscriptionRange(key: string): string | undefined;
    /** The range one holding recipe declares for a dependency, `*` when none, `undefined` when unreadable. */
    dependencyRange(holder: string, key: string): string | undefined;
}

/**
 * The range an always-pull check may move one locked recipe within: every holder's range at once,
 * or `undefined` when any cannot be read (then the pin stays).
 */
export function effectiveRangeForHolders(key: string, requestedBy: readonly string[], lookup: DeclaredRangeLookup): string | undefined {
    const ranges: string[] = [];

    for (const holder of requestedBy) {
        const declared = holder === PROJECT_HOLDER ? lookup.subscriptionRange(key) : lookup.dependencyRange(holder, key);

        if (declared === undefined) {
            return undefined;
        }

        ranges.push(declared);
    }

    if (ranges.length === 0) {
        return undefined;
    }

    const constraints = [...new Set(ranges.filter((range) => range !== "*"))];

    if (constraints.length === 0) {
        return "*";
    }

    const combined = constraints.join(" ");

    return semver.validRange(combined) === null ? undefined : combined;
}

/** How long a build waits on a repository it checks only to say whether something newer exists. */
export const NEWER_VERSION_CHECK_TIMEOUT_MS = 3000;

/**
 * Runs upstream work with a deadline. The work gets a signal that fires at the deadline, and the
 * promise rejects then; the timer never keeps the process open.
 */
export async function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, milliseconds: number): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`The repository did not answer within ${formatSeconds(milliseconds)}, so sous stopped waiting for it.`));
        }, milliseconds);
        timer.unref?.();
    });

    try {
        return await Promise.race([work(controller.signal), deadline]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
}

/** "3 seconds", "1 second". */
function formatSeconds(milliseconds: number): string {
    const seconds = Math.round((milliseconds / 1000) * 10) / 10;

    return seconds === 1 ? "1 second" : `${seconds} seconds`;
}
