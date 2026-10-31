import { describe, expect, it } from "vitest";
import { NonInteractiveError } from "./errors.js";
import { nonInteractivePrompter, scriptedPrompter } from "./prompter.js";

describe("nonInteractivePrompter", () => {
    /**
     * Every question fails with a NonInteractiveError naming the flag that answers it.
     */
    it("should refuse every question, naming the flag", async () => {
        expect(nonInteractivePrompter.interactive).toBe(false);
        await expect(nonInteractivePrompter.confirm({ message: "Remove the 3 files listed above?", answeredBy: "--yes" })).rejects.toThrow(
            'sous needed to ask "Remove the 3 files listed above?" but cannot ask questions in this run. Pass --yes to answer it ahead of time.',
        );
        await expect(nonInteractivePrompter.askValue({ message: "Name?" })).rejects.toBeInstanceOf(NonInteractiveError);
        await expect(nonInteractivePrompter.askChoice({ message: "Which?", choices: [] })).rejects.toBeInstanceOf(NonInteractiveError);
    });
});

describe("scriptedPrompter()", () => {
    /**
     * It answers from a list, in order, recording what was asked; running out fails like a
     * non-interactive prompter.
     */
    it("should answer from a list in order", async () => {
        const prompter = scriptedPrompter(["alice", 2, true]);

        expect(await prompter.askValue({ message: "Name?" })).toBe("alice");
        expect(await prompter.askChoice({ message: "Which?", choices: [{ label: "two", value: 2 }] })).toBe(2);
        expect(await prompter.confirm({ message: "Sure?" })).toBe(true);
        await expect(prompter.confirm({ message: "Again?", answeredBy: "--yes" })).rejects.toBeInstanceOf(NonInteractiveError);
        expect(prompter.asked).toEqual(["Name?", "Which?", "Sure?", "Again?"]);
    });
});
