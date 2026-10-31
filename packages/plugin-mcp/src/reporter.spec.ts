import type { ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { IntentOutputs, type LogLevel, ReportEntryStyle, TextBlock, VariableSet } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { McpReporter } from "./reporter.js";

function make(threshold: LogLevel, progressToken?: string) {
    const sent: ServerNotification[] = [];
    const reporter = new McpReporter({
        send: async (notification) => {
            sent.push(notification);
        },
        threshold: () => threshold,
        ...(progressToken === undefined ? {} : { progressToken }),
    });

    return { sent, reporter };
}

describe("McpReporter", () => {
    it("sends messages at or above the threshold, keeping their level", () => {
        const { sent, reporter } = make("notice");

        reporter.info("hidden");
        reporter.notice("shown");
        reporter.critical("bad", { path: "x" });

        expect(sent).toEqual([
            { method: "notifications/message", params: { level: "notice", logger: "sous", data: "shown" } },
            { method: "notifications/message", params: { level: "critical", logger: "sous", data: { message: "bad", style: "plain", path: "x" } } },
        ]);
    });

    it("sends a styled message with its style and details next to the plain message", () => {
        const { sent, reporter } = make("info");

        reporter.note("Because.");
        reporter.operation("written", "/a/b.md", { tokens: 3 });

        expect(sent.map((notification) => notification.params)).toEqual([
            { level: "notice", logger: "sous", data: { message: "Because.", style: "note" } },
            { level: "info", logger: "sous", data: { message: "written: /a/b.md", style: "operation", action: "written", target: "/a/b.md", tokens: 3 } },
        ]);
    });

    it("sends an error's cause chain as text and as errors", () => {
        const { sent, reporter } = make("info");

        reporter.warning(new Error("Could not download", { cause: new Error("DNS failed") }));

        expect(sent.map((notification) => notification.params)).toEqual([
            {
                level: "warning",
                logger: "sous",
                data: {
                    message: "Could not download\nCaused by: DNS failed",
                    style: "plain",
                    errors: [
                        { name: "Error", message: "Could not download" },
                        { name: "Error", message: "DNS failed" },
                    ],
                },
            },
        ]);
    });

    it("sends a payload's text as the message and its plain fields next to it", () => {
        const { sent, reporter } = make("info");

        reporter.log("info", new VariableSet({ Recipe: "acme/git" }), undefined, ReportEntryStyle.VariableList);
        reporter.log("info", new TextBlock("Hello."), undefined, ReportEntryStyle.Note);

        expect(sent.map((notification) => (notification.params as { data: unknown }).data)).toEqual([
            { message: "Recipe: acme/git", style: "variable-list", Recipe: "acme/git" },
            { message: "Hello.", style: "note", text: "Hello." },
        ]);
    });

    it("does not send a command's result, since the tool call returns it", () => {
        const { sent, reporter } = make("debug");

        reporter.result(IntentOutputs.of({ done: true }));

        expect(sent).toEqual([]);
    });

    it("drops the banner", () => {
        const { sent, reporter } = make("debug");

        reporter.banner();

        expect(sent).toEqual([]);
    });

    it("sends progress with the call's token, always rising", () => {
        const { sent, reporter } = make("info", "t1");

        reporter.progress({ label: "Working", item: "a" });
        reporter.progress({ label: "Working", item: "b" });

        expect(sent.map((notification) => notification.params)).toEqual([
            { progressToken: "t1", progress: 1, message: "Working: a" },
            { progressToken: "t1", progress: 2, message: "Working: b" },
        ]);
    });

    it("sends progress as debug messages without a token", () => {
        const { sent, reporter } = make("debug");

        reporter.progress({ label: "Working", finished: true });

        expect(sent).toEqual([{ method: "notifications/message", params: { level: "debug", logger: "sous", data: "Working: done" } }]);
    });

    it("never fails when the client is gone", () => {
        const reporter = new McpReporter({ send: () => Promise.reject(new Error("closed")), threshold: () => "debug" });

        expect(() => reporter.warning("x")).not.toThrow();
    });
});
