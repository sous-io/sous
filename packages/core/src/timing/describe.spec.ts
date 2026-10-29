import { describe, expect, it } from "vitest";
import type { TimingCategory } from "@sous-io/plugin-api";
import { describeOverBudget } from "./describe.js";

const over = (category: TimingCategory, name: string, plugin?: string) => ({ key: `${category}:${name}`, category, name, plugin, ms: 12.4, budgetMs: 5 });

describe("describeOverBudget()", () => {
    /**
     * Each category is described in plain words, with the time and the budget, and a pointer to
     * --timings.
     *
     * the intent "build" took 12ms (budget 5ms).
     */
    it("should describe every category in plain words", () => {
        const first = (category: TimingCategory, name: string, plugin?: string) => describeOverBudget(over(category, name, plugin), []).split("\n")[0];

        expect(first("config.build", "config")).toBe("building the config took 12ms (budget 5ms).");
        expect(first("config.build", "what-if #3")).toBe("building the what-if #3 config took 12ms (budget 5ms).");
        expect(first("config.stage", "7")).toBe("config stage 7 took 12ms (budget 5ms).");
        expect(first("config.pass", "0.2")).toBe("config pass 0.2 took 12ms (budget 5ms).");
        expect(first("config.validate", "config")).toBe("checking the config took 12ms (budget 5ms).");
        expect(first("contributor", "c")).toBe('the contributor "c" took 12ms (budget 5ms).');
        expect(first("plugin.load", "./x.mjs")).toBe('loading the plugin "./x.mjs" took 12ms (budget 5ms).');
        expect(first("plugin.register", "p")).toBe("registering the plugin p took 12ms (budget 5ms).");
        expect(first("chain", "build")).toBe('the chain started by "build" took 12ms (budget 5ms).');
        expect(first("intent", "build")).toBe('the intent "build" took 12ms (budget 5ms).');
        expect(first("listener", "build.before:p", "p")).toBe('a listener of p for "build.before" took 12ms (budget 5ms).');
        expect(first("listener", "build.before:p")).toBe('a listener of p for "build.before" took 12ms (budget 5ms).');
        expect(first("service.create", "git.runner")).toBe('creating the service "git.runner" took 12ms (budget 5ms).');
        expect(first("service.method", "git.runner.run")).toBe("the service call git.runner.run() took 12ms (budget 5ms).");
        expect(first("entity.method", "harness:claude.launch")).toBe("the entity method harness:claude.launch() took 12ms (budget 5ms).");
    });

    /**
     * A build, stage or pass over budget names the slowest contributor in it.
     */
    it("should name the slowest contributor of a slow build", () => {
        const batch = [over("contributor", "a"), { ...over("contributor", "b"), ms: 610 }, over("intent", "x")];

        expect(describeOverBudget(over("config.stage", "0"), batch)).toBe(
            "config stage 0 took 12ms (budget 5ms).\n  b took 610ms of that.\n  See every timing with --timings.",
        );
        expect(describeOverBudget(over("config.build", "config"), [])).toBe("building the config took 12ms (budget 5ms).\n  See every timing with --timings.");
    });
});
