import type { JsonObject, TimingCategory } from "@sous-io/plugin-api";

/**
 * The default budget of every timing category, in milliseconds (L5). These are first guesses; S1
 * says they are set from measurements during the refactor. A test fails when a category has none.
 */
export const DEFAULT_BUDGETS: Readonly<Record<TimingCategory, number>> = Object.freeze({
    "config.build": 200,
    "config.stage": 200,
    "config.pass": 100,
    "config.validate": 50,
    contributor: 100,
    "plugin.load": 100,
    "plugin.register": 20,
    chain: 30_000,
    intent: 10_000,
    listener: 1_000,
    "service.create": 100,
    "service.method": 5_000,
    "entity.method": 5_000,
});

/** A budget: milliseconds, or `false` for no warning. */
export type Budget = number | false;

/**
 * Looks budgets up: `budgets."<category>:<name>"` first, then `budgets."<category>"`, then the
 * default (C50).
 *
 * ```jsonc
 * "budgets": {
 *     "contributor": 100,
 *     "contributor:confd/530-team.js": false
 * }
 * ```
 */
export class BudgetTable {
    private readonly cache = new Map<string, Budget>();

    constructor(
        private readonly defaults: Readonly<Record<TimingCategory, Budget>>,
        private readonly overrides: JsonObject = {},
    ) {}

    /** The budget for one timed key. */
    budgetFor(category: TimingCategory, key: string): Budget {
        let budget = this.cache.get(key);

        if (budget === undefined) {
            budget = asBudget(this.overrides[key]) ?? asBudget(this.overrides[category]) ?? this.defaults[category];
            this.cache.set(key, budget);
        }

        return budget;
    }
}

function asBudget(value: unknown): Budget | undefined {
    if (value === false) {
        return false;
    }

    return typeof value === "number" && value >= 0 ? value : undefined;
}
