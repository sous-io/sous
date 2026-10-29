import { describe, expect, it } from "vitest";
import { BufferedReporter, createReporter, isLevelShown, isLogLevel, LOG_LEVELS, nullReporter } from "./reporter.js";

describe("LOG_LEVELS", () => {
    /**
     * The reporter uses the eight syslog levels in full, least severe first (S1, "Log levels"; C67).
     */
    it("should list the eight syslog levels in order (C67)", () => {
        expect(LOG_LEVELS).toEqual(["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"]);
    });
});

describe("isLevelShown()", () => {
    /**
     * A message shows when its level is at or above the threshold (C61).
     *
     * isLevelShown("warning", "notice") → true; isLevelShown("debug", "info") → false
     */
    it("should show messages at or above the threshold (C61)", () => {
        expect(isLevelShown("warning", "notice")).toBe(true);
        expect(isLevelShown("notice", "notice")).toBe(true);
        expect(isLevelShown("debug", "info")).toBe(false);
        expect(isLevelShown("emergency", "debug")).toBe(true);
    });
});

describe("isLogLevel()", () => {
    /**
     * Only the eight names are levels.
     */
    it("should recognize level names", () => {
        expect(isLogLevel("notice")).toBe(true);
        expect(isLogLevel("warn")).toBe(false);
        expect(isLogLevel(3)).toBe(false);
    });
});

describe("createReporter()", () => {
    /**
     * A full reporter is built from a log function; note and warning are shorthands.
     */
    it("should build note and warning on log", () => {
        const lines: string[] = [];
        const progress: string[] = [];
        const reporter = createReporter((level, message) => void lines.push(`${level}: ${message}`), (event) => void progress.push(event.label));

        reporter.note("a");
        reporter.warning("b");
        reporter.log("debug", "c");
        reporter.progress({ label: "Downloading recipes" });
        createReporter(() => {}).progress({ label: "ignored" });
        nullReporter.warning("dropped");

        expect(lines).toEqual(["notice: a", "warning: b", "debug: c"]);
        expect(progress).toEqual(["Downloading recipes"]);
    });
});

describe("BufferedReporter", () => {
    /**
     * It keeps every message and progress event, and hands them on in order.
     */
    it("should keep messages and flush them to another reporter", () => {
        const buffered = new BufferedReporter();
        const target = new BufferedReporter();

        buffered.note("one", { a: 1 });
        buffered.warning("two");
        buffered.progress({ label: "p", done: 1, total: 2 });

        expect(buffered.at("notice")).toEqual(["one"]);
        buffered.flushTo(target);

        expect(buffered.messages).toEqual([]);
        expect(target.messages).toEqual([
            { level: "notice", message: "one", details: { a: 1 } },
            { level: "warning", message: "two" },
        ]);
        expect(target.progressEvents).toEqual([{ label: "p", done: 1, total: 2 }]);
    });
});
