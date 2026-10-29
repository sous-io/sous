import { describe, expect, it } from "vitest";
import { cliAuthStatus, cliFailure, cliJson, cliOutput, firstUrlIn, runCli } from "./cli.js";
import { fakeProcesses, hostContext } from "./testing.js";

const GH = { command: "gh", label: "the GitHub CLI", install: "https://cli.github.com" };

describe("runCli()", () => {
    /**
     * A missing CLI fails with how to install it, and that it is needed only to propose changes.
     *
     * runCli(GH, ["pr", "list"], ctx) // gh missing -> "The GitHub CLI ('gh') is not installed."
     */
    it("should say how to install a missing CLI", async () => {
        const ctx = hostContext({ services: { "host.processes": fakeProcesses({}) } });
        const error = (await runCli(GH, ["pr", "list"], ctx).catch((caught: unknown) => caught)) as Error & { details: string[] };

        expect(error.message).toBe("The GitHub CLI ('gh') is not installed.");
        expect(error.details[0]).toContain("only to propose changes");
    });

    /**
     * The CLI gets the caller's environment plus what the host adds.
     *
     * runCli(GH, ["pr", "list"], ctx, { env: { GH_HOST: "ghe" } }) // env holds PATH and GH_HOST
     */
    it("should pass the environment with the host's additions", async () => {
        const processes = fakeProcesses({ installed: ["gh"] });

        await runCli(GH, ["pr", "list"], hostContext({ services: { "host.processes": processes }, env: { PATH: "/bin" } }), { env: { GH_HOST: "ghe" } });

        expect(processes.runs[0]?.options?.env).toEqual({ PATH: "/bin", GH_HOST: "ghe" });
    });
});

describe("cliOutput() and cliJson()", () => {
    /**
     * cliOutput gives trimmed output, or undefined when the command failed; cliJson parses JSON.
     *
     * cliOutput(GH, ["api", "user"], ctx); // -> "octocat"
     */
    it("should give output, undefined on failure, and parsed JSON", async () => {
        const ok = hostContext({ services: { "host.processes": fakeProcesses({ installed: ["gh"], answer: () => ({ stdout: ' [{"a":1}] \n' }) }) } });
        const failing = hostContext({ services: { "host.processes": fakeProcesses({ installed: ["gh"], answer: () => ({ exitCode: 1, stderr: "nope" }) }) } });
        const garbage = hostContext({ services: { "host.processes": fakeProcesses({ installed: ["gh"], answer: () => ({ stdout: "not json" }) }) } });

        expect(await cliOutput(GH, ["x"], ok)).toBe('[{"a":1}]');
        expect(await cliOutput(GH, ["x"], failing)).toBeUndefined();
        expect(await cliJson(GH, ["x"], "pr list", "pull request", ok)).toEqual([{ a: 1 }]);
        await expect(cliJson(GH, ["x"], "pr list", "pull request", failing)).rejects.toThrow("'gh pr list' did not succeed.");
        await expect(cliJson(GH, ["x"], "pr list", "pull request", garbage)).rejects.toThrow("printed something that is not JSON");
    });
});

describe("cliFailure()", () => {
    /**
     * cliFailure(GH, "pr create", { stderr: "no" }, "so no proposal was opened");
     * // -> "'gh pr create' did not succeed, so no proposal was opened." with details ["no"]
     */
    it("should name the command, what did not happen and what it printed", () => {
        const error = cliFailure(GH, "pr create", { stdout: "", stderr: "no\n" }, "so no proposal was opened");

        expect(error.message).toBe("'gh pr create' did not succeed, so no proposal was opened.");
        expect(error.details).toEqual(["no"]);
    });
});

describe("firstUrlIn()", () => {
    /**
     * firstUrlIn("Created https://github.com/o/r/pull/7\n"); // -> "https://github.com/o/r/pull/7"
     */
    it("should find the first address", () => {
        expect(firstUrlIn("Created https://github.com/o/r/pull/7\n")).toBe("https://github.com/o/r/pull/7");
        expect(firstUrlIn("nothing")).toBeUndefined();
    });
});

describe("cliAuthStatus()", () => {
    /**
     * `<cli> auth status` exiting 0 is signed in; anything else explains what to install and run.
     *
     * // gh auth status exits 0 -> { ok: true, detail: "the GitHub CLI ('gh') is installed and signed in." }
     */
    it("should report whether the CLI is installed and signed in", async () => {
        const signedIn = hostContext({ services: { "host.processes": fakeProcesses({ installed: ["gh"] }) } });
        const missing = hostContext({ services: { "host.processes": fakeProcesses({}) } });

        expect(await cliAuthStatus(GH, signedIn)).toEqual({ ok: true, detail: "the GitHub CLI ('gh') is installed and signed in." });

        const status = await cliAuthStatus(GH, missing);

        expect(status.ok).toBe(false);
        expect(status.detail).toContain("Install it from https://cli.github.com, then run 'gh auth login'.");
    });
});
