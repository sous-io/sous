import { BufferedReporter, ReportEntryStyle } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { thresholdOf } from "./front-end.js";
import { reportResult, reportTimings } from "./views.js";

describe("reportResult()", () => {
    /**
     * Text is reported as text, scalars as text, anything else as data; nothing for undefined or null.
     *
     * reportResult(reporter, { a: 1 }); // -> a Data entry
     */
    it("should report each kind of result", () => {
        const reporter = new BufferedReporter();

        reportResult(reporter, undefined);
        reportResult(reporter, null);
        reportResult(reporter, "done");
        reportResult(reporter, 3);
        reportResult(reporter, false);
        reportResult(reporter, 10n);
        reportResult(reporter, { a: 1 });

        expect(reporter.messages.map((entry) => [entry.style, entry.message])).toEqual([
            [ReportEntryStyle.Text, "done"],
            [ReportEntryStyle.Text, "3"],
            [ReportEntryStyle.Text, "false"],
            [ReportEntryStyle.Text, "10"],
            [ReportEntryStyle.Data, '{\n  "a": 1\n}'],
        ]);
    });
});

describe("reportTimings()", () => {
    /** One table row per timing, slowest total first, with calls, total, max and budget. */
    it("should list timings slowest first with their budgets", () => {
        const reporter = new BufferedReporter();

        reportTimings(reporter, [
            { key: "intent:a", category: "intent", name: "a", plugin: "p", count: 1, totalMs: 1, maxMs: 1, budgetMs: 10, overBudget: 0 },
            { key: "contributor:b", category: "contributor", name: "b", plugin: "p", count: 2, totalMs: 9, maxMs: 6, budgetMs: false, overBudget: 1 },
        ]);

        const [table] = reporter.styled(ReportEntryStyle.Table);
        const details = table!.details as { title: string; rows: Array<Record<string, unknown>> };

        expect(details.title).toBe("Timings");
        expect(details.rows.map((row) => row.name)).toEqual(["contributor:b", "intent:a"]);
        expect(details.rows[0]).toMatchObject({ calls: 2, total: "9.0 ms", max: "6.0 ms", budget: "no budget warning, 1 over" });
        expect(details.rows[1]).toMatchObject({ budget: "budget 10 ms" });
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
