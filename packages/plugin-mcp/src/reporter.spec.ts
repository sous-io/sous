import type { ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import type { LogLevel } from "@sous-io/plugin-api";
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

        reporter.log("info", "hidden");
        reporter.note("shown");
        reporter.log("critical", "bad", { path: "x" });

        expect(sent).toEqual([
            { method: "notifications/message", params: { level: "notice", logger: "sous", data: "shown" } },
            { method: "notifications/message", params: { level: "critical", logger: "sous", data: { message: "bad", path: "x" } } },
        ]);
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
