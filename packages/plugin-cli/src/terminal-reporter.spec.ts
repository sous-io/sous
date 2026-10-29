import { LOG_LEVELS } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { TerminalReporter } from "./terminal-reporter.js";

function stream(isTTY = false) {
    const written: string[] = [];

    return { written, write: (text: string) => written.push(text), isTTY };
}

describe("TerminalReporter", () => {
    /**
     * Messages at or above the threshold are written with their literal prefix; the rest are
     * dropped (C61, C67).
     *
     * new TerminalReporter(stderr, "warning").log("error", "x"); // -> "Error: x\n"
     */
    it("should write messages at or above the threshold with their prefix", () => {
        const out = stream();
        const reporter = new TerminalReporter(out, "warning");

        for (const level of LOG_LEVELS) {
            reporter.log(level, level);
        }

        expect(out.written).toEqual(["Warning: warning\n", "Error: error\n", "Critical: critical\n", "Alert: alert\n", "Emergency: emergency\n"]);
    });

    /** note and warning are the notice and warning levels; info is the default threshold. */
    it("should treat note as notice and warning as warning, showing info by default", () => {
        const out = stream();
        const reporter = new TerminalReporter(out);

        reporter.log("debug", "hidden");
        reporter.log("info", "shown");
        reporter.note("a note");
        reporter.warning("careful");

        expect(out.written).toEqual(["shown\n", "a note\n", "Warning: careful\n"]);
    });

    /** Progress rewrites one line in a terminal, and prints only the last event elsewhere. */
    it("should show progress on one line in a terminal and only the finish elsewhere", () => {
        const tty = stream(true);

        new TerminalReporter(tty).progress({ label: "Downloading", done: 1, total: 3, item: "a" });
        new TerminalReporter(tty).progress({ label: "Downloading", done: 3, finished: true });
        expect(tty.written).toEqual(["\r\u001b[2KDownloading 1/3 a", "\r\u001b[2KDownloading 3\n"]);

        const pipe = stream(false);

        new TerminalReporter(pipe).progress({ label: "Downloading", done: 1, total: 3 });
        new TerminalReporter(pipe).progress({ label: "Done", finished: true });
        expect(pipe.written).toEqual(["Done\n"]);

        const quiet = stream(true);

        new TerminalReporter(quiet, "error").progress({ label: "x", finished: true });
        expect(quiet.written).toEqual([]);
    });
});
