import { PassThrough } from "node:stream";
import { NonInteractiveError } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import { canPrompt, TerminalPrompter } from "./terminal-prompter.js";

function prompter(input: string, interactive = true) {
    const stdin = new PassThrough();
    const written: string[] = [];

    stdin.end(input);

    return { prompter: new TerminalPrompter(stdin, { write: (text: string) => written.push(text) } as never, interactive), written };
}

describe("TerminalPrompter", () => {
    /** Without a terminal every question throws NonInteractiveError naming the flag (L4, C46). */
    it("should refuse every question when it cannot ask, naming the flag", async () => {
        const { prompter: p } = prompter("", false);

        await expect(p.confirm({ message: "Go?", answeredBy: "--yes" })).rejects.toThrow(NonInteractiveError);
        await expect(p.askValue({ message: "Name?", answeredBy: "--name <name>" })).rejects.toThrow("Pass --name <name> to answer it ahead of time.");
        await expect(p.askChoice({ message: "Which?", choices: [{ label: "a", value: 1 }] })).rejects.toThrow(NonInteractiveError);
    });

    /** askValue returns the answer, or the default for an empty one, asking again while invalid. */
    it("should ask for a value, use the default, and ask again when invalid", async () => {
        expect(await prompter("main\n").prompter.askValue({ message: "Name?" })).toBe("main");
        expect(await prompter("\n").prompter.askValue({ message: "Name?", default: "core" })).toBe("core");

        const { prompter: p, written } = prompter("bad\ngood\n");
        const answer = await p.askValue({ message: "Name?", validate: (value) => (value === "bad" ? "Not that one." : undefined) });

        expect(answer).toBe("good");
        expect(written.join("")).toContain("Not that one.");
    });

    /**
     * A secret is read from the terminal with its echo off, one `*` shown per character typed, so
     * the answer never appears on screen (ported from the old value prompt's "should mask the
     * value for a secret").
     *
     * ? What is the token? ******
     */
    it("should mask the value for a secret", async () => {
        const stdin = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => void };
        const modes: boolean[] = [];
        const written: string[] = [];

        stdin.isTTY = true;
        stdin.setRawMode = (mode) => modes.push(mode);

        const p = new TerminalPrompter(stdin, { write: (text: string) => written.push(text) } as never, true);
        const answer = p.askValue({ message: "What is the token?", secret: true, default: "hidden-default" });

        stdin.write("abc1234\u007f\r");

        expect(await answer).toBe("abc123");
        expect(written.join("")).toBe("What is the token? *******\b \b\n");
        expect(written.join("")).not.toContain("abc123");
        expect(written.join("")).not.toContain("hidden-default");
        expect(modes).toEqual([true, false]);
    });

    /** askChoice lists the options, numbered, and takes a number or the default. */
    it("should ask for a choice by number", async () => {
        const choices = [
            { label: "claude", value: "claude", description: "Claude Code" },
            { label: "codex", value: "codex" },
        ];
        const { prompter: p, written } = prompter("7\n2\n");

        expect(await p.askChoice({ message: "Which harness?", choices })).toBe("codex");
        expect(written.join("")).toContain("Which harness?\n  1. claude: Claude Code\n  2. codex\n");
        expect(written.join("")).toContain("Pick a number from 1 to 2.");
        expect(await prompter("\n").prompter.askChoice({ message: "Which?", choices, defaultIndex: 0 })).toBe("claude");
    });

    /** confirm takes yes or no, the default for an empty answer, and asks again otherwise. */
    it("should confirm with yes, no or the default", async () => {
        expect(await prompter("y\n").prompter.confirm({ message: "Go?" })).toBe(true);
        expect(await prompter("no\n").prompter.confirm({ message: "Go?" })).toBe(false);
        expect(await prompter("\n").prompter.confirm({ message: "Go?", default: true })).toBe(true);

        const { prompter: p, written } = prompter("maybe\nyes\n");

        expect(await p.confirm({ message: "Go?", default: false })).toBe(true);
        expect(written.join("")).toContain("Go? [y/N]");
        expect(written.join("")).toContain("Answer yes or no.");
    });
});

describe("TerminalPrompter at the end of input", () => {
    /** When standard input ends before an answer, the question fails instead of waiting or looping. */
    it("should fail a question when standard input has ended", async () => {
        await expect(prompter("").prompter.confirm({ message: "Go?", answeredBy: "--yes" })).rejects.toThrow("Pass --yes");
        await expect(prompter("maybe\n").prompter.confirm({ message: "Go?" })).rejects.toThrow(NonInteractiveError);

        const { prompter: p } = prompter("");

        await expect(p.askValue({ message: "Name?" })).rejects.toThrow(NonInteractiveError);
        await expect(p.askValue({ message: "Again?" })).rejects.toThrow(NonInteractiveError);
    });
});

describe("canPrompt()", () => {
    const tty = { stdin: { isTTY: true }, stdout: { isTTY: true } };

    /**
     * A prompt is possible only with a terminal on both ends, no CI variable and no
     * --non-interactive (about-cli-command-design, rule 5).
     */
    it("should allow prompts only in an interactive terminal", () => {
        expect(canPrompt(tty, {})).toBe(true);
        expect(canPrompt({ stdin: { isTTY: false }, stdout: { isTTY: true } }, {})).toBe(false);
        expect(canPrompt({ stdin: { isTTY: true }, stdout: {} }, {})).toBe(false);
        expect(canPrompt(tty, { CI: "true" })).toBe(false);
        expect(canPrompt(tty, { CI: "false" })).toBe(true);
        expect(canPrompt(tty, { CI: "0" })).toBe(true);
        expect(canPrompt(tty, { CI: "" })).toBe(true);
        expect(canPrompt(tty, {}, { "non-interactive": true })).toBe(false);
    });
});
