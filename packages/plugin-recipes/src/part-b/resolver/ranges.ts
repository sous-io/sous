/**
 * Reading the ranges recorded dependencies ask for, and combining ranges. The one place that knows
 * how an index entry written before ADR 0023 (an exact `version`) is read, and how two ranges are
 * required at once.
 */

import semver from "semver";
import type { IndexDependency } from "@sous-io/plugin-formats/types";
import type { SousRef } from "@sous-io/plugin-refs/types";

/**
 * The range one recorded dependency asks for (ADR 0023): the range the manifest declared, else the
 * range the release recorded (`^<version>` for a sibling named with no range). An entry written
 * before ADR 0023 carries the exact `version` that release resolved instead; it is read as
 * `^<version>`, limited by the declared range when there is one.
 *
 * ```ts
 * recordedRange({ range: "^1.1.2" }, undefined);    // "^1.1.2"
 * recordedRange({ version: "1.1.1" }, "^1.0.0");    // "^1.1.1"
 * recordedRange({ version: "1.1.1" }, "~1.1.0");    // ">=1.1.1 <2.0.0-0 >=1.1.0 <1.2.0-0"
 * recordedRange(undefined, "^2");                   // "^2"
 * ```
 *
 * @param recorded - What the index records for the dependency, if anything.
 * @param declared - The range the manifest entry naming the dependency was written with.
 */
export function recordedRange(recorded: IndexDependency | undefined, declared: string | undefined): string | undefined {
    if (recorded?.version !== undefined) {
        const caret = `^${recorded.version}`;

        return declared === undefined ? caret : intersectRanges(caret, declared);
    }

    return declared ?? recorded?.range;
}

/**
 * One range every version of which satisfies both ranges: the narrower one when one holds the
 * other, else every pairing of their comparator sets. A range semver cannot read is returned as
 * the left one, so the resolver's own error names it.
 *
 * ```ts
 * intersectRanges("^1.1.1", "^1.0.0"); // "^1.1.1"
 * intersectRanges("^1.1.1", "~1.1.0"); // ">=1.1.1 <2.0.0-0 >=1.1.0 <1.2.0-0"
 * ```
 */
export function intersectRanges(left: string, right: string): string {
    try {
        if (semver.subset(left, right)) {
            return left;
        }

        if (semver.subset(right, left)) {
            return right;
        }

        const sets = (range: string): string[] => new semver.Range(range).set.map((comparators) => comparators.map((comparator) => comparator.value).join(" "));

        return sets(left)
            .flatMap((one) => sets(right).map((other) => `${one} ${other}`.trim() || "*"))
            .join(" || ");
    } catch {
        return left;
    }
}

/**
 * The range a manifest entry was written with, when the entry names one recipe with a range.
 *
 * ```ts
 * declaredRange("workflow/sub-agent-delegation@^1.0.0", parse); // "^1.0.0"
 * declaredRange("workflow", parse);                             // undefined
 * ```
 *
 * @param declared - The manifest entry, as the index records it under `declared`.
 * @param parse - Every reading of a dependency as a manifest wrote it.
 */
export function declaredRange(declared: string | undefined, parse: (written: string) => SousRef[]): string | undefined {
    if (declared === undefined) {
        return undefined;
    }

    for (const reading of parse(declared)) {
        if (reading.kind === "recipe" && reading.range !== undefined) {
            return reading.range;
        }
    }

    return undefined;
}
