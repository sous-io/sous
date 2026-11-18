import type { ElicitRequestFormParams, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { CancelledError, NonInteractiveError } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { argumentFor, ElicitationPrompter } from "./prompter.js";

function make(results: ElicitResult[]) {
    const asked: ElicitRequestFormParams[] = [];
    const prompter = new ElicitationPrompter({
        canElicit: true,
        retries: 1,
        elicit: async (params) => {
            asked.push(params);

            return results.shift() ?? { action: "cancel" };
        },
    });

    return { asked, prompter };
}

describe("argumentFor", () => {
    it("names the tool argument for a CLI flag", () => {
        expect(argumentFor("--yes")).toBe('the "yes" argument');
        expect(argumentFor("--harness <id>")).toBe('the "harness" argument');
        expect(argumentFor("--dry-run")).toBe('the "dryRun" argument');
        expect(argumentFor("<ref>")).toBe('the "ref" argument');
        expect(argumentFor(undefined)).toBeUndefined();
    });
});

describe("ElicitationPrompter", () => {
    it("asks for a value with its default", async () => {
        const { asked, prompter } = make([{ action: "accept", content: { answer: "x" } }]);

        await expect(prompter.askValue({ message: "Name?", default: "d" })).resolves.toBe("x");
        expect(asked[0]).toEqual({
            mode: "form",
            message: "Name?",
            requestedSchema: { type: "object", properties: { answer: { type: "string", title: "Name?", default: "d" } }, required: ["answer"] },
        });
    });

    it("gives up after the retries when the answer stays invalid", async () => {
        const { prompter } = make([
            { action: "accept", content: { answer: "x" } },
            { action: "accept", content: { answer: "y" } },
        ]);

        await expect(prompter.askValue({ message: "Name?", validate: () => "No." })).rejects.toBeInstanceOf(CancelledError);
    });

    it("offers choices by index and returns the picked value", async () => {
        const { asked, prompter } = make([{ action: "accept", content: { answer: "0" } }]);
        const value = await prompter.askChoice({
            message: "Pick",
            defaultIndex: 1,
            choices: [
                { label: "A", value: { id: "a" }, description: "first" },
                { label: "B", value: { id: "b" } },
            ],
        });

        expect(value).toEqual({ id: "a" });
        expect(asked[0]!.requestedSchema.properties.answer).toEqual({
            type: "string",
            title: "Pick",
            oneOf: [
                { const: "0", title: "A: first" },
                { const: "1", title: "B" },
            ],
            default: "1",
        });
    });

    it("confirms with a boolean", async () => {
        const { prompter } = make([{ action: "accept", content: { answer: false } }]);

        await expect(prompter.confirm({ message: "Sure?", default: true })).resolves.toBe(false);
    });

    it("cancels when the person cancels", async () => {
        const { prompter } = make([{ action: "cancel" }]);

        await expect(prompter.confirm({ message: "Sure?" })).rejects.toThrow(/cancelled in the MCP client/);
    });

    it("fails naming the argument when the client cannot elicit", async () => {
        const prompter = new ElicitationPrompter({ canElicit: false, elicit: () => Promise.reject(new Error("never")) });

        expect(prompter.interactive).toBe(false);
        await expect(prompter.confirm({ message: "Sure?", answeredBy: "--yes" })).rejects.toBeInstanceOf(NonInteractiveError);
        await expect(prompter.confirm({ message: "Sure?", answeredBy: "--yes" })).rejects.toThrow('Pass the "yes" argument');
    });
});
