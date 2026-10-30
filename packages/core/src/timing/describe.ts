import type { OverBudget } from "./timer.js";

/**
 * A warning for a call that went over budget, in plain words:
 *
 * ```text
 * building the config took 840ms (budget 200ms).
 *   confd/530-team.js took 610ms of that.
 *   See every timing with --timings.
 * ```
 */
export function describeOverBudget(over: OverBudget, batch: readonly OverBudget[]): string {
    const lines = [`${subject(over)} took ${ms(over.ms)} (budget ${ms(over.budgetMs)}).`];

    if (over.category === "config.build" || over.category === "config.stage" || over.category === "config.pass") {
        const slowest = [...batch].filter((item) => item.category === "contributor").sort((a, b) => b.ms - a.ms)[0];

        if (slowest) {
            lines.push(`  ${slowest.name} took ${ms(slowest.ms)} of that.`);
        }
    }

    lines.push("  See every timing with --timings.");

    return lines.join("\n");
}

function subject(over: OverBudget): string {
    switch (over.category) {
        case "config.build":
            return over.name === "config" ? "building the config" : `building the ${over.name} config`;
        case "config.stage":
            return `config stage ${over.name}`;
        case "config.pass":
            return `config pass ${over.name}`;
        case "config.validate":
            return "checking the config";
        case "contributor":
            return `the contributor "${over.name}"${over.plugin ? ` (${over.plugin})` : ""}`;
        case "plugin.load":
            return `loading the plugin "${over.name}"`;
        case "plugin.register":
            return `registering the plugin ${over.name}`;
        case "chain":
            return `the chain started by "${over.name}"`;
        case "intent":
            return `the intent "${over.name}"`;
        case "listener": {
            const split = over.name.lastIndexOf(":");

            return `a listener of ${over.plugin ?? over.name.slice(split + 1)} for "${over.name.slice(0, split)}"`;
        }
        case "service.create":
            return `creating the service "${over.name}"`;
        case "service.method":
            return `the service call ${over.name}()`;
        case "entity.method":
            return `the entity method ${over.name}()`;
    }
}

function ms(value: number): string {
    return `${Math.round(value)}ms`;
}
