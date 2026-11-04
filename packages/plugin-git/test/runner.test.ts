import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isSousError } from "@sous-io/plugin-api";
import type { HostProcesses, ProcessResult } from "@sous-io/plugin-host/types";
import { batchSshCommand, GIT_DOWNLOAD_TIMEOUT_MS, GitError } from "../src/index.js";
import { git, realRunner, runnerOver } from "./helpers.js";

/** A stand-in for `host.processes` that records calls and answers from a function. */
function fakeProcesses(answer: (args: readonly string[]) => Partial<ProcessResult>) {
    const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> | undefined }> = [];
    const result = (command: string, args: readonly string[]): ProcessResult => ({
        command,
        args,
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        durationMs: 3,
        timedOut: false,
        ...answer(args),
    });
    const processes: HostProcesses = {
        async run(command, args, options) {
            calls.push({ command, args, options: options as Record<string, unknown> });

            return result(command, args);
        },
        runSync(command, args, options) {
            calls.push({ command, args, options: options as Record<string, unknown> });

            return result(command, args);
        },
        async runInteractive() {
            return { exitCode: 0, signal: null, durationMs: 0 };
        },
        async which(command) {
            return command === "git" ? "/usr/bin/git" : undefined;
        },
    };

    return { processes, calls };
}

describe("git.runner over a stand-in for host.processes", () => {
    /** Output loses only its final newline, the timing comes through, and git never prompts. */
    it("should run git through host.processes and never let it prompt", async () => {
        const { processes, calls } = fakeProcesses(() => ({ stdout: "abc123\n" }));
        const runner = await runnerOver(processes);

        const result = await runner.run(["rev-parse", "HEAD"], { cwd: "/repo", env: { MORE: "1" } });

        expect(result).toEqual({ args: ["rev-parse", "HEAD"], exitCode: 0, stdout: "abc123", stderr: "", durationMs: 3 });
        expect(calls[0]!.command).toBe("git");
        expect(calls[0]!.options).toMatchObject({ cwd: "/repo", label: "git rev-parse", env: { PATH: "/bin", MORE: "1", GIT_TERMINAL_PROMPT: "0" } });
        expect(runner.runSync(["status"], { cwd: "/repo" }).stdout).toBe("abc123");
    });

    /** A failure names the command, the code, the directory and git's own words. */
    it("should throw a GitError naming the command, the code and stderr", async () => {
        const { processes } = fakeProcesses(() => ({ exitCode: 128, stderr: "fatal: Remote branch v1.0.0 not found\n" }));
        const runner = await runnerOver(processes);
        const error = await runner.run(["clone", "--branch", "v1.0.0", "x"], { cwd: "/repo" }).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(GitError);
        expect(isSousError(error)).toBe(true);
        expect((error as GitError).message).toBe("The command 'git clone --branch v1.0.0 x' failed with exit code 128.");
        expect((error as GitError).details).toEqual(["It was run in /repo.", "fatal: Remote branch v1.0.0 not found"]);
        expect((error as GitError).result.exitCode).toBe(128);
    });

    /** The same failure is returned, not thrown, when the caller asks. */
    it("should return a failure when reject is false", async () => {
        const { processes } = fakeProcesses(() => ({ exitCode: 1, stderr: "no" }));
        const runner = await runnerOver(processes);

        expect((await runner.run(["status"], { cwd: "/repo", reject: false })).exitCode).toBe(1);
        expect(() => runner.runSync(["status"], { cwd: "/repo" })).toThrow(GitError);
    });

    /** Exit code 127 says git has to be installed. */
    it("should explain that git must be installed", async () => {
        const { processes } = fakeProcesses(() => ({ exitCode: 127, stderr: "git is not installed, or is not on your PATH" }));
        const runner = await runnerOver(processes);
        const error = (await runner.run(["--version"], { cwd: "/" }).catch((caught: unknown) => caught)) as GitError;

        expect(error.details).toContain("Sous fetches recipes with git, so git must be installed and on your PATH.");
    });

    /** A run past its limit is a timeout, with the code of timeout(1) when it is returned. */
    it("should report a timeout", async () => {
        const { processes } = fakeProcesses(() => ({ exitCode: null, signal: "SIGKILL", timedOut: true, stderr: "partial" }));
        const runner = await runnerOver(processes);
        const error = (await runner.run(["fetch"], { cwd: "/r", timeoutMs: 10 }).catch((caught: unknown) => caught)) as GitError;

        expect(error.timedOut).toBe(true);
        expect(error.message).toContain("did not finish in time");
        expect((await runner.run(["fetch"], { cwd: "/r", timeoutMs: 10, reject: false })).exitCode).toBe(124);
    });

    /**
     * A clone that runs out of time says how long sous waits.
     *
     * runner.clone("https://example.test/o/r.git", "/r/x", { timeoutMs: 120_000 });
     * // -> GitError, details include "Sous stops this command after 120 seconds."
     */
    it("should name the time limit when a download is stopped", async () => {
        const { processes } = fakeProcesses((args) => (args[0] === "clone" ? { exitCode: null, signal: "SIGKILL", timedOut: true } : { exitCode: 1 }));
        const runner = await runnerOver(processes);
        const where = mkdtempSync(path.join(tmpdir(), "sous-git-timeout-"));

        try {
            const error = (await runner.clone("https://example.test/o/r.git", path.join(where, "x")).catch((caught: unknown) => caught)) as GitError;

            expect(error.timedOut).toBe(true);
            expect(error.details).toContain("Sous stops this command after 120 seconds.");
        } finally {
            rmSync(where, { recursive: true, force: true });
        }
    });

    /**
     * Every download runs ssh in batch mode with a time limit, so a host key ssh does not know
     * fails at once instead of asking on the terminal.
     *
     * runner.clone(url, dir);
     * // -> git clone ... with GIT_SSH_COMMAND="ssh -o BatchMode=yes" and timeoutMs 120000
     */
    it("should stop ssh from asking on the terminal during a download", async () => {
        const { processes, calls } = fakeProcesses(() => ({ exitCode: 1 }));
        const runner = await runnerOver(processes);
        const where = mkdtempSync(path.join(tmpdir(), "sous-git-batch-"));

        try {
            await runner.clone("git@example.test:o/r.git", path.join(where, "x")).catch(() => undefined);
            await runner.readRemoteFile("git@example.test:o/r.git", "sous.index.json").catch(() => undefined);
        } finally {
            rmSync(where, { recursive: true, force: true });
        }

        const clone = calls.find((call) => call.args[0] === "clone")!;
        const init = calls.find((call) => call.args[0] === "init")!;

        expect(clone.options).toMatchObject({ timeoutMs: GIT_DOWNLOAD_TIMEOUT_MS, env: { GIT_SSH_COMMAND: "ssh -o BatchMode=yes", GIT_TERMINAL_PROMPT: "0" } });
        expect(init.options).toMatchObject({ timeoutMs: GIT_DOWNLOAD_TIMEOUT_MS, env: { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" } });
    });

    /**
     * The user's own ssh command is kept: plain ssh gains batch mode, anything else is left alone.
     *
     * runner.clone(url, dir, { env: { GIT_SSH_COMMAND: "plink -batch" } });
     * // -> GIT_SSH_COMMAND stays "plink -batch"
     */
    it("should keep the user's own ssh command", async () => {
        const { processes, calls } = fakeProcesses((args) => (args[0] === "config" ? { stdout: "ssh -i /k/work\n" } : { exitCode: 1 }));
        const runner = await runnerOver(processes);
        const where = mkdtempSync(path.join(tmpdir(), "sous-git-own-"));

        try {
            await runner.clone("git@example.test:o/r.git", path.join(where, "a")).catch(() => undefined);
            await runner.clone("git@example.test:o/r.git", path.join(where, "b"), { env: { GIT_SSH_COMMAND: "plink -batch" } }).catch(() => undefined);
            await runner.clone("git@example.test:o/r.git", path.join(where, "c"), { env: { GIT_SSH: "/usr/bin/my-ssh" } }).catch(() => undefined);
        } finally {
            rmSync(where, { recursive: true, force: true });
        }

        const clones = calls.filter((call) => call.args[0] === "clone").map((call) => (call.options!.env as Record<string, string | undefined>).GIT_SSH_COMMAND);

        expect(clones).toEqual(["ssh -i /k/work -o BatchMode=yes", "plink -batch", undefined]);
        expect(calls.filter((call) => call.args[0] === "config")).toHaveLength(1);
    });

    /** Whether git is installed comes from `which`. */
    it("should know whether git is installed", async () => {
        const { processes } = fakeProcesses(() => ({ stdout: "git version 2.47.1.windows.1\n" }));
        const runner = await runnerOver(processes);

        expect(await runner.available()).toBe(true);
        expect(await runner.version()).toBe("2.47.1");
    });

    /** A ref that looks like an option is never handed to git. */
    it("should refuse to treat an option as a ref or a remote", async () => {
        const { processes, calls } = fakeProcesses(() => ({ stdout: "x" }));
        const runner = await runnerOver(processes);

        expect(await runner.revParse("--all", "/r")).toBeUndefined();
        expect(await runner.remoteUrl("/r", "--evil")).toBeUndefined();
        expect(calls).toHaveLength(0);
    });

    /** Renames in the porcelain list carry the path they came from. */
    it("should parse the status, renames included", async () => {
        const { processes } = fakeProcesses(() => ({ stdout: "R  new name.md\0old.md\0 M a.md\0?? b file.md" }));
        const runner = await runnerOver(processes);

        expect(await runner.status("/r")).toEqual([
            { path: "new name.md", code: "R ", from: "old.md" },
            { path: "a.md", code: " M" },
            { path: "b file.md", code: "??" },
        ]);
    });
});

describe("git.runner with a real git", () => {
    let dir: string;
    let repo: string;

    beforeEach(() => {
        dir = realpathSync(mkdtempSync(path.join(tmpdir(), "plugin-git-")));
        repo = path.join(dir, "origin");
        mkdirSync(path.join(repo, "recipes", "one"), { recursive: true });
        mkdirSync(path.join(repo, "recipes", "two"), { recursive: true });
        git(repo, "init", "--quiet", "--initial-branch=main");
        writeFileSync(path.join(repo, "recipes", "one", "a.md"), "one\n");
        writeFileSync(path.join(repo, "recipes", "two", "b.md"), "two\n");
        writeFileSync(path.join(repo, "README.md"), "# readme\n");
        git(repo, "add", ".");
        git(repo, "commit", "--quiet", "-m", "first");
        git(repo, "tag", "workflow@1.0.0");
        git(repo, "tag", "other");
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    /** The queries a link and a release ask of a checkout. */
    it("should answer the basic questions about a checkout", async () => {
        const runner = await realRunner();
        const head = git(repo, "rev-parse", "HEAD");

        expect(await runner.available()).toBe(true);
        expect(await runner.version()).toMatch(/^\d+\.\d+/);
        expect(await runner.root(path.join(repo, "recipes"))).toBe(repo);
        expect(await runner.root(dir)).toBeUndefined();
        expect(await runner.root(path.join(dir, "missing"))).toBeUndefined();
        expect(await runner.currentBranch(repo)).toBe("main");
        expect(await runner.revParse("HEAD", repo)).toBe(head);
        expect(await runner.revParse("workflow@1.0.0", repo)).toBe(head);
        expect(await runner.revParse("nope", repo)).toBeUndefined();
        expect(await runner.tags(repo)).toEqual(["other", "workflow@1.0.0"]);
        expect(await runner.tags(repo, "*@*")).toEqual(["workflow@1.0.0"]);
        expect(await runner.remoteUrl(repo)).toBeUndefined();

        git(repo, "remote", "add", "origin", "https://example.test/o/r.git");
        expect(await runner.remoteUrl(repo)).toBe("https://example.test/o/r.git");
        expect(await runner.remoteUrl(repo, "upstream")).toBeUndefined();

        git(repo, "checkout", "--quiet", "--detach");
        expect(await runner.currentBranch(repo)).toBeUndefined();
    });

    /** The working tree's changes, with the leading space of a code kept. */
    it("should list the status", async () => {
        const runner = await runnerReal();

        writeFileSync(path.join(repo, "README.md"), "changed\n");
        writeFileSync(path.join(repo, "new.md"), "new\n");
        git(repo, "mv", "recipes/one/a.md", "recipes/one/c.md");

        const entries = await runner.status(repo);

        expect(entries).toEqual([
            { path: "README.md", code: " M" },
            { path: "recipes/one/c.md", code: "R ", from: "recipes/one/a.md" },
            { path: "new.md", code: "??" },
        ]);
    });

    /** A failed command throws git's own message. */
    it("should throw git's message for a failure", async () => {
        const runner = await runnerReal();
        const error = (await runner.run(["checkout", "no-such-branch"], { cwd: repo }).catch((caught: unknown) => caught)) as GitError;

        expect(error).toBeInstanceOf(GitError);
        expect(error.details.join("\n")).toContain("no-such-branch");
        expect(error.result.exitCode).not.toBe(0);
    });

    /** A shallow clone of a branch, creating the parent directories. */
    it("should clone shallowly into a new directory", async () => {
        const runner = await runnerReal();
        const target = path.join(dir, "deep", "er", "copy");

        await runner.clone(repo, target, { depth: 1, branch: "main" });

        expect(readFileSync(path.join(target, "README.md"), "utf8")).toBe("# readme\n");
        expect(await runner.root(target)).toBe(target);
    });

    /** A sparse clone of a tag holds only the paths asked for. */
    it("should clone only the sparse paths at a tag", async () => {
        const runner = await runnerReal();
        const target = path.join(dir, "sparse");

        await runner.clone(pathToFileURL(repo).href, target, { depth: 1, branch: "workflow@1.0.0", sparsePaths: ["recipes/one"] });

        expect(existsSync(path.join(target, "recipes", "one", "a.md"))).toBe(true);
        expect(existsSync(path.join(target, "recipes", "two", "b.md"))).toBe(false);
    });

    /**
     * A clone keeps the committed bytes even where git is set to turn LF into CRLF on checkout
     * (Git for Windows' default), because recipes are hashed over their raw bytes.
     */
    it("should check files out with the committed line endings whatever git's settings are", async () => {
        const runner = await runnerReal();
        const target = path.join(dir, "line-endings");
        // The user's own git settings, as Git for Windows writes them.
        const globalConfig = path.join(dir, "global.gitconfig");

        writeFileSync(globalConfig, "[core]\n\tautocrlf = true\n");
        await runner.clone(repo, target, { env: { GIT_CONFIG_GLOBAL: globalConfig } });

        expect(readFileSync(path.join(target, "README.md"), "utf8")).toBe("# readme\n");
        expect(await runner.run(["config", "core.autocrlf"], { cwd: target })).toMatchObject({ stdout: "false" });
    });

    /** A clone with no checkout leaves no files. */
    it("should clone without a checkout", async () => {
        const runner = await runnerReal();
        const target = path.join(dir, "bare-ish");

        await runner.clone(repo, target, { noCheckout: true });

        expect(existsSync(path.join(target, "README.md"))).toBe(false);
        expect(await runner.root(target)).toBe(target);
    });

    /** A URL that looks like an option is a path to git, never an option. */
    it("should not take a leading hyphen for an option", async () => {
        const runner = await runnerReal();

        await expect(runner.clone("--upload-pack=touch evil", path.join(dir, "x"))).rejects.toThrow(GitError);
        expect(existsSync(path.join(dir, "evil"))).toBe(false);
    });

    /** One file is read from a remote without leaving a clone behind. */
    it("should read one file from a remote", async () => {
        const runner = await runnerReal();

        expect(await runner.readRemoteFile(`file://${repo}`, "recipes/two/b.md")).toBe("two");
        expect(await runner.readRemoteFile(`file://${repo}`, "README.md", { ref: "workflow@1.0.0" })).toBe("# readme");
    });

    /** A missing file is an error naming the path. */
    it("should fail when the remote file is missing", async () => {
        const runner = await runnerReal();
        const error = (await runner.readRemoteFile(`file://${repo}`, "nope.md").catch((caught: unknown) => caught)) as GitError;

        expect(error).toBeInstanceOf(GitError);
        expect(error.details.join("\n")).toContain("nope.md");
        await expect(runner.readRemoteFile("--bad", "x")).rejects.toThrow(GitError);
    });

    /** The synchronous run gives the same result. */
    it("should run synchronously", async () => {
        const runner = await runnerReal();

        expect(runner.runSync(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo }).stdout).toBe("main");
        expect(runner.runSync(["rev-parse", "nope"], { cwd: repo, reject: false }).exitCode).not.toBe(0);
    });
});

describe("batchSshCommand()", () => {
    /**
     * batchSshCommand adds batch mode to plain ssh, keeps a command that already sets it, and
     * leaves any other program alone.
     *
     * batchSshCommand("ssh -i k");  // -> "ssh -i k -o BatchMode=yes"
     * batchSshCommand("plink");     // -> undefined
     */
    it("should add batch mode only to plain ssh", () => {
        expect(batchSshCommand(undefined)).toBe("ssh -o BatchMode=yes");
        expect(batchSshCommand("  ")).toBe("ssh -o BatchMode=yes");
        expect(batchSshCommand("ssh -i ~/.ssh/work")).toBe("ssh -i ~/.ssh/work -o BatchMode=yes");
        expect(batchSshCommand('"C:\\Program Files\\OpenSSH\\ssh.exe" -v')).toBe('"C:\\Program Files\\OpenSSH\\ssh.exe" -v -o BatchMode=yes');
        expect(batchSshCommand("/usr/bin/ssh")).toBe("/usr/bin/ssh -o BatchMode=yes");
        expect(batchSshCommand("ssh -o BatchMode=no")).toBe("ssh -o BatchMode=no");
        expect(batchSshCommand("plink -batch")).toBeUndefined();
    });
});

const runnerReal = () => realRunner();
