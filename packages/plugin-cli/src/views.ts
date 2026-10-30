import type { TimingEntry } from "@sous-io/plugin-api";

export { renderResult } from "./views/show.js";

/**
 * Every timing of the run, for `--timings`: one line per key, slowest total first.
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
