import type { TimingEntry } from "@sous-io/plugin-api";

/**
 * How a result is printed: nothing for `undefined` or `null`, text as it is, anything else as JSON.
 */
export function renderResult(result: unknown): string | undefined {
    if (result === undefined || result === null) {
        return undefined;
    }

    if (typeof result === "string") {
        return result.endsWith("\n") ? result : `${result}\n`;
    }

    if (typeof result === "number" || typeof result === "boolean" || typeof result === "bigint") {
        return `${String(result)}\n`;
    }

    return `${JSON.stringify(result, null, 2)}\n`;
}

/**
 * Every timing of the run, for `--timings` (C52): one line per key, slowest total first.
 *
 * ```text
 * Timings:
 *   config.build:config          1 call     12.4ms total   12.4ms max   budget 200ms
 * ```
 */
export function renderTimings(entries: readonly TimingEntry[]): string {
    const sorted = [...entries].sort((a, b) => b.totalMs - a.totalMs);
    const width = Math.min(48, Math.max(0, ...sorted.map((entry) => entry.key.length)));
    const lines = sorted.map((entry) => {
        const calls = `${entry.count} call${entry.count === 1 ? "" : "s"}`.padStart(9);
        const total = `${entry.totalMs.toFixed(1)}ms total`.padStart(15);
        const max = `${entry.maxMs.toFixed(1)}ms max`.padStart(13);
        const budget = entry.budgetMs === false ? "no budget warning" : `budget ${entry.budgetMs}ms`;
        const over = entry.overBudget > 0 ? `, ${entry.overBudget} over` : "";

        return `  ${entry.key.padEnd(width)} ${calls} ${total} ${max}   ${budget}${over}`;
    });

    return `Timings:\n${lines.join("\n")}\n`;
}
