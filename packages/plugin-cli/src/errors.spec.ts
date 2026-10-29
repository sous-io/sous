import { InputError, NonInteractiveError, SousError } from "@sous-io/plugin-api";
import { describe, expect, it } from "vitest";
import type { Command } from "./command-tree.js";
import { viewError } from "./errors.js";

describe("viewError()", () => {
    /**
     * A sous error shows `Error: ` and its details, indented, with its exit code.
     *
     * viewError(new SousError("Broken.", { details: ["Fix it."] })) // -> ["Error: Broken.", "  Fix it."], 1
     */
    it("should show a sous error's message, details and exit code", () => {
        expect(viewError(new SousError("Broken.", { details: ["Fix it."], exitCode: 4 }))).toEqual({ lines: ["Error: Broken.", "  Fix it."], exitCode: 4 });
        expect(viewError(new NonInteractiveError("Go?", "--yes")).exitCode).toBe(2);
    });

    /** Any other error shows its message with exit code 1; a thrown string works too. */
    it("should show other errors with exit code 1", () => {
        expect(viewError(new TypeError("bad"))).toEqual({ lines: ["Error: bad"], exitCode: 1 });
        expect(viewError("plain")).toEqual({ lines: ["Error: plain"], exitCode: 1 });
    });

    /** With `debug`, the stack follows the message. */
    it("should add the stack with debug", () => {
        expect(viewError(new SousError("x"), { debug: true }).lines.length).toBeGreaterThan(1);
        expect(viewError(new Error("y"), { debug: true }).lines[1]).toMatch(/^ {2}at /);
    });

    /** Input errors name the flag or positional argument, not the input field. */
    it("should name flags and arguments in input errors", () => {
        const command = {
            flags: [{ field: "mode", name: "mode" }],
            positionals: [{ field: "url", name: "url" }],
        } as unknown as Command;
        const error = new InputError("repo.add", [
            { path: "url", message: "Required, but missing." },
            { path: "mode", message: "Expected one of a, b." },
            { path: "other.x", message: "Odd." },
            { path: "", message: "Whole input." },
        ]);

        expect(viewError(error, { command }).lines).toEqual([
            'Error: The input to "repo.add" is not valid.',
            "  <url>: Required, but missing.",
            "  --mode: Expected one of a, b.",
            "  other.x: Odd.",
            "  Whole input.",
        ]);
    });
});
