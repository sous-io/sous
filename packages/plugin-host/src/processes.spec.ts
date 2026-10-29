import { mkdtempSync, chmodSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProcesses, NOT_FOUND_EXIT_CODE, ProcessError } from "./processes.js";

const node = process.execPath;
const processes = createProcesses({ env: { PATH: process.env.PATH, FROM_SERVICE: "service" } });

describe("run()", () => {
    /** Output, exit code and timing come back. */
    it("should capture output and time the run", async () => {
        const result = await processes.run(node, ["-e", "console.log('out'); console.error('err')"]);

        expect(result).toMatchObject({ command: node, exitCode: 0, signal: null, stdout: "out\n", stderr: "err\n", timedOut: false });
        expect(result.durationMs).toBeGreaterThan(0);
    });

    /** A non-zero exit is a result, unless the caller asks for it to throw. */
    it("should return a failure, or throw it with reject", async () => {
        const result = await processes.run(node, ["-e", "console.error('bad'); process.exit(3)"]);

        expect(result.exitCode).toBe(3);

        const error = await processes.run(node, ["-e", "console.error('bad'); process.exit(3)"], { reject: true }).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(ProcessError);
        expect((error as ProcessError).result.exitCode).toBe(3);
        expect((error as ProcessError).message).toContain("failed with exit code 3");
        expect((error as ProcessError).details).toEqual(["bad"]);
    });

    /** Input goes to standard input. */
    it("should write the input", async () => {
        const result = await processes.run(node, ["-e", "process.stdin.pipe(process.stdout)"], { input: "piped" });

        expect(result.stdout).toBe("piped");
    });

    /** The working directory and the environment come from the options, then the service. */
    it("should use the given cwd and env, defaulting to the service's", async () => {
        const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "host-proc-")));
        const script = "console.log(process.cwd(), process.env.FROM_SERVICE, process.env.CUSTOM)";

        try {
            expect((await processes.run(node, ["-e", script], { cwd: dir })).stdout).toBe(`${dir} service undefined\n`);
            expect((await processes.run(node, ["-e", script], { env: { CUSTOM: "mine", PATH: undefined } })).stdout).toContain("undefined mine");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    /** A run past its limit is killed and says so. */
    it("should kill a run that takes too long", async () => {
        const result = await processes.run(node, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 100 });

        expect(result.timedOut).toBe(true);
        expect(result.signal).toBe("SIGKILL");
        await expect(processes.run(node, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 100, reject: true })).rejects.toThrow(/did not finish in time/);
    });

    /** A command that is not installed gives exit code 127 and a plain reason. */
    it("should report a missing command", async () => {
        const result = await processes.run("sous-no-such-command", []);

        expect(result.exitCode).toBe(NOT_FOUND_EXIT_CODE);
        expect(result.stderr).toContain("not installed");
    });

    /** A missing working directory is not mistaken for a missing command. */
    it("should report a missing directory", async () => {
        const result = await processes.run(node, ["-e", "0"], { cwd: "/no/such/directory" });

        expect(result.exitCode).toBe(NOT_FOUND_EXIT_CODE);
        expect(result.stderr).toBe("The directory /no/such/directory does not exist");
        expect(processes.runSync(node, ["-e", "0"], { cwd: "/no/such/directory" }).stderr).toContain("does not exist");
    });

    /** An abort signal stops the run. */
    it("should stop when aborted", async () => {
        const controller = new AbortController();
        const pending = processes.run(node, ["-e", "setTimeout(() => {}, 10000)"], { signal: controller.signal });

        setTimeout(() => controller.abort(), 50);

        const result = await pending;

        expect(result.exitCode).toBeNull();
    });
});

describe("runSync()", () => {
    /** The same result, blocking. */
    it("should run and capture", () => {
        const result = processes.runSync(node, ["-e", "console.log('sync'); process.exit(2)"]);

        expect(result).toMatchObject({ stdout: "sync\n", exitCode: 2, timedOut: false });
        expect(() => processes.runSync(node, ["-e", "process.exit(2)"], { reject: true })).toThrow(ProcessError);
    });

    /** Timeouts and missing commands come back the same way as the async ones. */
    it("should report a timeout and a missing command", () => {
        expect(processes.runSync(node, ["-e", "setTimeout(() => {}, 10000)"], { timeoutMs: 100 }).timedOut).toBe(true);
        expect(processes.runSync("sous-no-such-command", []).exitCode).toBe(NOT_FOUND_EXIT_CODE);
    });
});

describe("runInteractive()", () => {
    /** The exit code and timing come back. */
    it("should return how it ended", async () => {
        const result = await processes.runInteractive(node, ["-e", "process.exit(4)"]);

        expect(result.exitCode).toBe(4);
        expect(result.durationMs).toBeGreaterThan(0);
        expect((await processes.runInteractive("sous-no-such-command", [])).exitCode).toBe(NOT_FOUND_EXIT_CODE);
    });
});

describe("which()", () => {
    /** A command is found on the given PATH, and only when it can be run. */
    it("should find executables on PATH", async () => {
        const dir = mkdtempSync(path.join(tmpdir(), "host-which-"));
        const tool = path.join(dir, "mytool");

        try {
            writeFileSync(tool, "#!/bin/sh\n");
            chmodSync(tool, 0o755);
            writeFileSync(path.join(dir, "plain"), "x");

            expect(await processes.which("mytool", { PATH: dir })).toBe(tool);
            expect(await processes.which("plain", { PATH: dir })).toBeUndefined();
            expect(await processes.which("mytool", { PATH: "" })).toBeUndefined();
            expect(await processes.which(tool, {})).toBe(tool);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
