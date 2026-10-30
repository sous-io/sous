import { describe, expect, it } from "vitest";
import { thresholdOf } from "./front-end.js";
import { renderResult, renderTimings } from "./views.js";

describe("renderResult()", () => {
    /**
     * Text prints as it is, scalars as text, anything else as JSON; nothing for undefined or null.
     *
     * renderResult({ a: 1 }); // -> '{\n  "a": 1\n}\n'
     */
    it("should print each kind of result", () => {
        expect(renderResult(undefined)).toBeUndefined();
        expect(renderResult(null)).toBeUndefined();
        expect(renderResult("done")).toBe("done\n");
        expect(renderResult("done\n")).toBe("done\n");
        expect(renderResult(3)).toBe("3\n");
        expect(renderResult(false)).toBe("false\n");
        expect(renderResult(10n)).toBe("10\n");
        expect(renderResult({ a: 1 })).toBe('{\n  "a": 1\n}\n');
    });
});

describe("renderTimings()", () => {
    /** Every timing, slowest total first, with calls, total, max and budget. */
    it("should list timings slowest first with their budgets", () => {
        const text = renderTimings([
            { key: "intent:a", category: "intent", name: "a", plugin: "p", count: 1, totalMs: 1, maxMs: 1, budgetMs: 10, overBudget: 0 },
            { key: "contributor:b", category: "contributor", name: "b", plugin: "p", count: 2, totalMs: 9, maxMs: 6, budgetMs: false, overBudget: 1 },
        ]);

        expect(text.split("\n")[0]).toBe("Timings:");
        expect(text.indexOf("contributor:b")).toBeLessThan(text.indexOf("intent:a"));
        expect(text).toMatch(/contributor:b\s+2 calls\s+9\.0ms total\s+6\.0ms max\s+no budget warning, 1 over/);
        expect(text).toMatch(/intent:a\s+1 call\s+1\.0ms total\s+1\.0ms max\s+budget 10ms/);
    });
});

describe("thresholdOf()", () => {
    /** `--debug` means debug; `--log-level` sets a valid level; anything else gives info. */
    it("should pick the threshold from --debug and --log-level", () => {
        expect(thresholdOf({ debug: true, "log-level": "error" })).toBe("debug");
        expect(thresholdOf({ "log-level": "error" })).toBe("error");
        expect(thresholdOf({ "log-level": "nonsense" })).toBe("info");
        expect(thresholdOf({})).toBe("info");
    });
});
