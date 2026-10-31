import type { Reporter, TimingEntry } from "@sous-io/plugin-api";

/**
 * Reports every timing of the run, for `--timings`: one row per key, slowest total first.
 *
 * ```text
 * ➔ Timings:
 *   Name                 Calls  Total     Max      Budget
 *   config.build:config      1  12.4 ms   12.4 ms  200 ms
 * ```
 */
export function reportTimings(reporter: Reporter, entries: readonly TimingEntry[]): void {
    const rows = [...entries]
        .sort((a, b) => b.totalMs - a.totalMs)
        .map((entry) => ({
            name: entry.key,
            calls: entry.count,
            total: `${entry.totalMs.toFixed(1)} ms`,
            max: `${entry.maxMs.toFixed(1)} ms`,
            budget: `${entry.budgetMs === false ? "no budget warning" : `budget ${entry.budgetMs} ms`}${entry.overBudget > 0 ? `, ${entry.overBudget} over` : ""}`,
        }));

    reporter.table(
        [
            { key: "name", header: "Name", overflow: "truncate", truncate: "middle" },
            { key: "calls", header: "Calls", kind: "number" },
            { key: "total", header: "Total", kind: "number" },
            { key: "max", header: "Max", kind: "number" },
            { key: "budget", header: "Budget", priority: "low" },
        ],
        rows,
        { title: "Timings" },
        "notice",
    );
}
