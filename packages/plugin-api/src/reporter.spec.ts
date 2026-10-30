import { describe, expect, it } from "vitest";
import {
    BaseReporter,
    BufferedReporter,
    createReporter,
    isLevelShown,
    isLogLevel,
    LOG_LEVELS,
    LogLevel,
    nullReporter,
    ReportEntryStyle,
    Reporting,
    type Reporter,
} from "./reporter.js";

describe("LOG_LEVELS", () => {
    /**
     * The reporter uses the eight syslog levels in full, least severe first.
     */
    it("should list the eight syslog levels in order", () => {
        expect(LOG_LEVELS).toEqual(["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"]);
    });
});

describe("isLevelShown()", () => {
    /**
     * A message shows when its level is at or above the threshold.
     *
     * isLevelShown("warning", "notice") → true; isLevelShown("debug", "info") → false
     */
    it("should show messages at or above the threshold", () => {
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
     * Every method ends in the one function, with its level and style.
     *
     * reporter.notice("a") → ("notice", "a", undefined, "plain")
     */
    it("should send every message to the function, with its level and style", () => {
        const lines: string[] = [];
        const reporter = createReporter((level, message, _details, style) => void lines.push(`${level} ${style}: ${message}`));

        reporter.notice("a");
        reporter.warn("b");
        reporter.log(LogLevel.Debug, "c");
        reporter.progress({ label: "Downloading recipes" });
        nullReporter.warning("dropped");

        expect(lines).toEqual(["notice plain: a", "warning plain: b", "debug plain: c", "info progress: Downloading recipes"]);
    });
});

describe("BaseReporter", () => {
    class Lines extends BaseReporter {
        readonly lines: string[] = [];

        protected write(level: LogLevel, message: string): void {
            this.lines.push(`${level}: ${message}`);
        }
    }

    /**
     * Each level has a method, plus warn and emerg; each ends in log() at its level.
     */
    it("should give one method per level, plus warn and emerg", () => {
        const reporter = new Lines();

        reporter.debug("1");
        reporter.info("2");
        reporter.notice("3");
        reporter.warning("4");
        reporter.warn("5");
        reporter.error("6");
        reporter.critical("7");
        reporter.alert("8");
        reporter.emergency("9");
        reporter.emerg("10");

        expect(reporter.lines).toEqual([
            "debug: 1",
            "info: 2",
            "notice: 3",
            "warning: 4",
            "warning: 5",
            "error: 6",
            "critical: 7",
            "alert: 8",
            "emergency: 9",
            "emergency: 10",
        ]);
    });

    /**
     * Messages below the threshold are dropped; a threshold function is read on every message.
     */
    it("should drop messages below the threshold, reading a function threshold each time", () => {
        let threshold: LogLevel = LogLevel.Warning;
        const fixed = new (class extends Lines {
            constructor() {
                super(LogLevel.Warning);
            }
        })();
        const moving = new (class extends Lines {
            constructor() {
                super(() => threshold);
            }
        })();

        fixed.notice("dropped");
        fixed.error("kept");
        moving.info("dropped");
        threshold = LogLevel.Info;
        moving.info("kept");

        expect(fixed.lines).toEqual(["error: kept"]);
        expect(moving.lines).toEqual(["info: kept"]);
    });
});

describe("Reporting()", () => {
    /**
     * A class that mixes it in gets every reporting method except log, each sent to its reporter.
     *
     * new Task(buffered).warn("x") → buffered holds { level: "warning", message: "x" }
     */
    it("should copy the reporting methods onto a class, sending them to its reporter", () => {
        class Task extends Reporting(Object) {
            constructor(private readonly target: BufferedReporter) {
                super();
            }

            protected get reporter(): Reporter {
                return this.target;
            }
        }

        const buffered = new BufferedReporter();
        const task = new Task(buffered);

        task.warn("x");
        task.notice("y", { a: 1 });
        task.progress({ label: "p" });

        expect(buffered.messages).toEqual([
            { level: "warning", message: "x", style: "plain" },
            { level: "notice", message: "y", details: { a: 1 }, style: "plain" },
            { level: "info", message: "p", details: { label: "p" }, style: "progress" },
        ]);
        expect("log" in Task.prototype).toBe(false);
    });
});

describe("BufferedReporter", () => {
    /**
     * It keeps every message with its style, and hands them on in order.
     */
    it("should keep messages and flush them to another reporter", () => {
        const buffered = new BufferedReporter();
        const target = new BufferedReporter();

        buffered.notice("one", { a: 1 });
        buffered.warning("two");
        buffered.progress({ label: "p", done: 1, total: 2 });

        expect(buffered.at("notice")).toEqual(["one"]);
        expect(buffered.styled(ReportEntryStyle.Progress)).toHaveLength(1);
        buffered.flushTo(target);

        expect(buffered.messages).toEqual([]);
        expect(target.messages).toEqual([
            { level: "notice", message: "one", details: { a: 1 }, style: "plain" },
            { level: "warning", message: "two", style: "plain" },
            { level: "info", message: "p", details: { label: "p", done: 1, total: 2 }, style: "progress" },
        ]);
    });
});

describe("style methods", () => {
    /**
     * Each style method forces its style, fills typed details, writes a plain message, and has a
     * default level the last parameter overrides.
     *
     * operation("failed", "/a") → { level: "error", style: "operation", details: { action: "failed", target: "/a" } }
     */
    it("should force their style, fill details, and default the level", () => {
        const reporter = new BufferedReporter();

        reporter.operationStart("Building the project");
        reporter.operation("written", "/a/CLAUDE.md", { tokens: 10 });
        reporter.operation("failed", "/a/AGENTS.md");
        reporter.variables({ Project: "app", Config: "/a/.sous/sous.config.js" }, "Command");
        reporter.problem("It broke.", { cause: "disk full", hint: "Free some space." });
        reporter.note("Explained.", LogLevel.Info);

        expect(reporter.messages).toEqual([
            { level: "notice", message: "Building the project", details: { name: "Building the project" }, style: "operation-start" },
            { level: "info", message: "written: /a/CLAUDE.md", details: { action: "written", target: "/a/CLAUDE.md", tokens: 10 }, style: "operation" },
            { level: "error", message: "failed: /a/AGENTS.md", details: { action: "failed", target: "/a/AGENTS.md" }, style: "operation" },
            {
                level: "info",
                message: "Command\n  Project: app\n  Config: /a/.sous/sous.config.js",
                details: {
                    title: "Command",
                    entries: [
                        { label: "Project", value: "app" },
                        { label: "Config", value: "/a/.sous/sous.config.js" },
                    ],
                },
                style: "variable-list",
            },
            {
                level: "warning",
                message: "It broke.\n  disk full\n  Free some space.",
                details: { summary: "It broke.", cause: "disk full", hint: "Free some space." },
                style: "problem",
            },
            { level: "info", message: "Explained.", style: "note" },
        ]);
    });
});
