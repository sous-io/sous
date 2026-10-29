import { describe, expect, it } from "vitest";
import { canonicalRepository } from "./urls.js";
import { fakeGit, fakeProcesses, hostContext } from "./testing.js";
import { singleWord, tokenFromOutput } from "./token-output.js";
import { cliTokenSource, envTokenSource, gitCredentialTokenSource, passwordIn } from "./token-sources.js";

const repository = canonicalRepository("gitlab.com", "acme", "recipes");

describe("tokenFromOutput()", () => {
    /**
     * A token command's output is a token only when it exited 0 and printed exactly one non-empty
     * line holding no whitespace (S4). This is what stops glab's help text being taken as a token.
     *
     * tokenFromOutput({ exitCode: 0, stdout: "glpat-abc\n" }); // -> "glpat-abc"
     * tokenFromOutput({ exitCode: 0, stdout: "Usage: glab auth <command>\n..." }); // -> undefined
     */
    it("should accept only one non-empty line with no whitespace from a successful command", () => {
        expect(tokenFromOutput({ exitCode: 0, stdout: "glpat-abc\n" })).toBe("glpat-abc");
        expect(tokenFromOutput({ exitCode: 0, stdout: "glpat-abc" })).toBe("glpat-abc");
        expect(tokenFromOutput({ exitCode: 1, stdout: "glpat-abc\n" })).toBeUndefined();
        expect(tokenFromOutput({ exitCode: 0, stdout: "" })).toBeUndefined();
        expect(tokenFromOutput({ exitCode: 0, stdout: "Usage: glab auth <command> [flags]\n\nCommands:\n" })).toBeUndefined();
        expect(tokenFromOutput({ exitCode: 0, stdout: "a\nb\n" })).toBeUndefined();
        expect(tokenFromOutput({ exitCode: 0, stdout: " token\n" })).toBeUndefined();
        expect(tokenFromOutput({ exitCode: null, stdout: "x\n" })).toBeUndefined();
    });

    /**
     * singleWord allows one final newline, nothing else.
     *
     * singleWord("abc\r\n"); // -> "abc"
     */
    it("should allow one final newline", () => {
        expect(singleWord("abc\r\n")).toBe("abc");
        expect(singleWord("abc\n\n")).toBeUndefined();
    });
});

describe("envTokenSource()", () => {
    /**
     * The first variable set wins; when none is, the reason names them and the fix exports the first.
     *
     * envTokenSource({ variables: ["GITHUB_TOKEN", "GH_TOKEN"] }) with GH_TOKEN=x
     * // -> { token: { value: "x", source: "GH_TOKEN" } }
     */
    it("should read the first variable set, and name them all when none is", async () => {
        const source = envTokenSource({ variables: ["GITHUB_TOKEN", "GH_TOKEN"], tokenHint: "a token" });

        expect(await source.find(repository, hostContext({ env: { GH_TOKEN: " x " } }))).toEqual({ token: { value: "x", source: "GH_TOKEN" } });
        expect(await source.token(repository, hostContext({ env: { GITHUB_TOKEN: "y", GH_TOKEN: "x" } }))).toEqual({ value: "y", source: "GITHUB_TOKEN" });
        expect(await source.find(repository, hostContext({ env: { GITHUB_TOKEN: "  " } }))).toEqual({ missing: "GITHUB_TOKEN and GH_TOKEN unset" });
        expect(source.fix?.(repository)).toBe("export GITHUB_TOKEN=<a token>");
    });
});

describe("gitCredentialTokenSource()", () => {
    /**
     * It asks `git credential fill` for https://<host>, prompts off, and takes the password line.
     *
     * git credential fill <<< "protocol=https\nhost=gitlab.com\n\n"
     * // prints "password=glpat-x" -> { value: "glpat-x", source: "git credential fill" }
     */
    it("should take the password git stores for the host", async () => {
        const git = fakeGit({ runAnswer: () => ({ exitCode: 0, stdout: "protocol=https\nhost=gitlab.com\nusername=me\npassword=glpat-x" }) });
        const found = await gitCredentialTokenSource().token(repository, hostContext({ services: { "git.runner": git } }));

        expect(found).toEqual({ value: "glpat-x", source: "git credential fill" });

        const [call] = git.calls;
        const [args, options] = call!.args as [string[], { input: string; env: Record<string, string> }];

        expect(args).toEqual(["credential", "fill"]);
        expect(options.input).toBe("protocol=https\nhost=gitlab.com\n\n");
        expect(options.env["GIT_TERMINAL_PROMPT"]).toBe("0");
    });

    /**
     * When git has nothing stored it fails; the reason says so.
     *
     * // git exits 128: "terminal prompts disabled" -> { missing: "git has no stored credential for gitlab.com" }
     */
    it("should say git has no stored credential when it fails", async () => {
        const git = fakeGit({ runAnswer: () => ({ exitCode: 128, stderr: "fatal: could not read Username: terminal prompts disabled" }) });

        expect(await gitCredentialTokenSource().find(repository, hostContext({ services: { "git.runner": git } }))).toEqual({
            missing: "git has no stored credential for gitlab.com",
        });
        expect(await gitCredentialTokenSource().find(repository, hostContext())).toEqual({ missing: "git has no stored credential for gitlab.com" });
    });

    /**
     * passwordIn reads only a one-word password.
     *
     * passwordIn("password=a b"); // -> undefined
     */
    it("should refuse a password holding whitespace", () => {
        expect(passwordIn("username=x\npassword=a b\n")).toBeUndefined();
        expect(passwordIn("username=x\n")).toBeUndefined();
    });
});

describe("cliTokenSource()", () => {
    const glab = cliTokenSource({ id: "glab", command: "glab", args: (repo) => ["config", "get", "token", "--host", repo.host] });

    /**
     * A CLI that is not installed is skipped silently, never required.
     *
     * // glab missing -> { missing: undefined }, and nothing is run
     */
    it("should skip a CLI that is not installed, saying nothing", async () => {
        const processes = fakeProcesses({ installed: [] });

        expect(await glab.find(repository, hostContext({ services: { "host.processes": processes } }))).toEqual({ missing: undefined });
        expect(processes.runs).toEqual([]);
    });

    /**
     * An installed CLI is run with the host, and its output passes the one-line check.
     *
     * glab config get token --host gitlab.com // prints "glpat-x\n" -> { value: "glpat-x", source: "glab" }
     */
    it("should run the CLI with the host and accept a one-line token", async () => {
        const processes = fakeProcesses({ installed: ["glab"], answer: () => ({ stdout: "glpat-x\n" }) });

        expect(await glab.token(repository, hostContext({ services: { "host.processes": processes } }))).toEqual({ value: "glpat-x", source: "glab" });
        expect(processes.runs[0]).toMatchObject({ command: "glab", args: ["config", "get", "token", "--host", "gitlab.com"] });
    });

    /**
     * Help text printed with exit code 0 (glab 1.114's `auth token`) is refused (S4, problem 2).
     *
     * // prints "Usage: glab auth <command> [flags]\n..." -> { missing: "glab printed no token for gitlab.com" }
     */
    it("should refuse help text printed with exit code 0", async () => {
        const processes = fakeProcesses({ installed: ["glab"], answer: () => ({ stdout: "Manage glab's authentication state.\n\nUSAGE\n  glab auth <command> [flags]\n" }) });

        expect(await glab.find(repository, hostContext({ services: { "host.processes": processes } }))).toEqual({ missing: "glab printed no token for gitlab.com" });
    });
});
