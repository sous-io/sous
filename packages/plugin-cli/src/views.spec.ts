import { BufferedReporter, ReportEntryStyle, type Table } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { thresholdOf } from "./front-end.js";
import { reportTimings } from "./views.js";

describe("reportTimings()", () => {
    /** One table row per timing, slowest total first, with calls, total, max and budget. */
    it("should list timings slowest first with their budgets", () => {
        const reporter = new BufferedReporter();

        reportTimings(reporter, [
            { key: "intent:a", category: "intent", name: "a", plugin: "p", count: 1, totalMs: 1, maxMs: 1, budgetMs: 10, overBudget: 0 },
            { key: "contributor:b", category: "contributor", name: "b", plugin: "p", count: 2, totalMs: 9, maxMs: 6, budgetMs: false, overBudget: 1 },
        ]);

        const [entry] = reporter.styled(ReportEntryStyle.Table);
        const table = entry!.message as Table;

        expect(table.title).toBe("Timings");
        expect(table.rows.map((row) => row.name)).toEqual(["contributor:b", "intent:a"]);
        expect(table.rows[0]).toMatchObject({ calls: 2, total: "9.0 ms", max: "6.0 ms", budget: "no budget warning, 1 over" });
        expect(table.rows[1]).toMatchObject({ budget: "budget 10 ms" });
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
