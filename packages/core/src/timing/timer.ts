import type { TimingCategory, TimingEntry, Timings } from "@sous-io/plugin-api";
import { type Budget, BudgetTable } from "./budgets.js";

interface MutableEntry {
    key: string;
    category: TimingCategory;
    name: string;
    plugin: string | undefined;
    count: number;
    totalMs: number;
    maxMs: number;
    overBudget: number;
}

/** One call that went over its budget. */
export interface OverBudget {
    readonly key: string;
    readonly category: TimingCategory;
    readonly name: string;
    readonly plugin: string | undefined;
    readonly ms: number;
    readonly budgetMs: number;
}

/**
 * Times every core stage and every call into a plugin (L5), and reports what goes over budget.
 *
 * Timing costs two `performance.now()` calls and one map update per call, so it costs almost
 * nothing when nothing is over budget.
 */
export class Timer implements Timings {
    private readonly table = new Map<string, MutableEntry>();
    private budgets: BudgetTable;
    private deferred: OverBudget[] | undefined;

    constructor(
        private readonly defaults: Readonly<Record<TimingCategory, Budget>>,
        private readonly onOverBudget: (over: OverBudget, batch: readonly OverBudget[]) => void,
        private readonly now: () => number = () => performance.now(),
    ) {
        this.budgets = new BudgetTable(defaults);
    }

    /** Uses the budgets of a newly built config. */
    setBudgets(overrides: Record<string, unknown> | undefined): void {
        this.budgets = new BudgetTable(this.defaults, (overrides ?? {}) as never);
    }

    /** The budget for one key. */
    budgetFor(category: TimingCategory, name: string): Budget {
        return this.budgets.budgetFor(category, `${category}:${name}`);
    }

    /**
     * Holds over-budget reports back until {@link releaseDeferred}, for the config build, whose
     * budgets are only known once it is built.
     */
    deferReports(): void {
        this.deferred ??= [];
    }

    /** Re-checks what was held back against the current budgets, and reports it. */
    releaseDeferred(): void {
        const held = this.deferred ?? [];

        this.deferred = undefined;

        for (const over of held) {
            const budget = this.budgetFor(over.category, over.name);

            if (budget !== false && over.ms > budget) {
                const entry = this.table.get(over.key);

                if (entry) {
                    entry.overBudget += 1;
                }

                this.onOverBudget({ ...over, budgetMs: budget }, held);
            }
        }
    }

    /**
     * Times a call, synchronous or not, and returns what it returns. A thrown error is timed too.
     */
    measure<T>(category: TimingCategory, name: string, plugin: string | undefined, fn: () => T): T {
        const start = this.now();
        let result: T;

        try {
            result = fn();
        } catch (error) {
            this.record(category, name, plugin, this.now() - start);
            throw error;
        }

        if (isPromiseLike(result)) {
            return Promise.resolve(result).finally(() => {
                this.record(category, name, plugin, this.now() - start);
            }) as T;
        }

        this.record(category, name, plugin, this.now() - start);

        return result;
    }

    /** Starts timing something that ends later; call the returned function when it ends. */
    start(category: TimingCategory, name: string, plugin?: string): () => number {
        const start = this.now();

        return () => {
            const ms = this.now() - start;

            this.record(category, name, plugin, ms);

            return ms;
        };
    }

    /** Adds one measured call. */
    record(category: TimingCategory, name: string, plugin: string | undefined, ms: number): void {
        const key = `${category}:${name}`;
        let entry = this.table.get(key);

        if (!entry) {
            entry = { key, category, name, plugin, count: 0, totalMs: 0, maxMs: 0, overBudget: 0 };
            this.table.set(key, entry);
        }

        entry.count += 1;
        entry.totalMs += ms;

        if (ms > entry.maxMs) {
            entry.maxMs = ms;
        }

        const budget = this.budgets.budgetFor(category, key);

        if (this.deferred) {
            this.deferred.push({ key, category, name, plugin, ms, budgetMs: budget === false ? 0 : budget });

            return;
        }

        if (budget !== false && ms > budget) {
            entry.overBudget += 1;
            this.onOverBudget({ key, category, name, plugin, ms, budgetMs: budget }, []);
        }
    }

    entries(): TimingEntry[] {
        return [...this.table.values()].map((entry) => this.toEntry(entry));
    }

    get(key: string): TimingEntry | undefined {
        const entry = this.table.get(key);

        return entry ? this.toEntry(entry) : undefined;
    }

    private toEntry(entry: MutableEntry): TimingEntry {
        return { ...entry, budgetMs: this.budgets.budgetFor(entry.category, entry.key) };
    }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return typeof (value as { then?: unknown } | null)?.then === "function";
}
