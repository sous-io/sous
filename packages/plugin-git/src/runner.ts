/**
 * `git.runner`: the one git runner for every caller. It uses the user's own `git`, so their
 * credentials, SSH agent, proxy settings and `insteadOf` rewrites all apply, and it runs through
 * `host.processes`, so every call is timed.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Environment } from "@sous-io/plugin-api";
import type { HostProcesses, ProcessResult } from "@sous-io/plugin-host/types";
import { GIT_TIMEOUT_EXIT_CODE, GitError } from "./errors.js";
import type { GitResult, GitRunner, GitRunOptions, GitStatusEntry } from "./types.js";

/**
 * `git clone` options that check files out exactly as they were committed.
 *
 * Recipes are hashed over their raw bytes, and Git for Windows installs with
 * `core.autocrlf=true`, which rewrites every text file to CRLF on checkout. A
 * recipe published with LF would then hash differently on such a machine and
 * fail its own pin. `--config` also writes these into the clone's own
 * `.git/config`, so later checkouts in that clone keep the same bytes.
 */
export const LF_CHECKOUT_OPTIONS = ["--config", "core.autocrlf=false", "--config", "core.eol=lf"] as const;

/**
 * How long one download step (a clone, or one step of reading a remote file) may take before it is
 * stopped, in milliseconds. A caller can pass its own `timeoutMs`.
 */
export const GIT_DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * The ssh command a download runs, so that ssh never stops to ask on the terminal (a host key it
 * does not know, a key passphrase). `GIT_TERMINAL_PROMPT=0` does not stop those questions: ssh asks
 * on `/dev/tty`, and several downloads at once would all ask at once and never finish.
 *
 * Returns `undefined` when the user's own command is not plain ssh; that command is left alone.
 *
 * ```ts
 * batchSshCommand(undefined);               // "ssh -o BatchMode=yes"
 * batchSshCommand("ssh -i ~/.ssh/work");    // "ssh -i ~/.ssh/work -o BatchMode=yes"
 * batchSshCommand("ssh -o BatchMode=no");   // "ssh -o BatchMode=no" (the user chose)
 * batchSshCommand("plink -batch");          // undefined
 * ```
 */
export function batchSshCommand(command: string | undefined): string | undefined {
    const trimmed = command?.trim() ?? "";

    if (trimmed.length === 0) {
        return "ssh -o BatchMode=yes";
    }

    if (/batchmode/i.test(trimmed)) {
        return trimmed;
    }

    // The program is the first word, or the first quoted run when its path holds spaces.
    const program = /^"([^"]*)"|^'([^']*)'|^(\S+)/.exec(trimmed)?.slice(1).find((part) => part !== undefined) ?? "";
    const name = program.split(/[\\/]/).pop() ?? "";

    return /^ssh(\.exe)?$/i.test(name) ? `${trimmed} -o BatchMode=yes` : undefined;
}

/** What the runner needs from the engine. */
export interface GitRunnerDeps {
    processes: HostProcesses;
    /** The environment git gets, besides what a call adds. */
    env: Environment;
}

/** Removes the one newline git ends its output with. */
function chomp(text: string): string {
    return text.replace(/\r?\n$/, "");
}

/** Whether text could be taken by git as an option. */
function looksLikeOption(text: string): boolean {
    return text.startsWith("-");
}

/** Makes the `git.runner` service. */
export function createGitRunner(deps: GitRunnerDeps): GitRunner {
    const environmentFor = (options: { env?: Environment }): Environment => ({
        ...deps.env,
        ...options.env,
        // A command must never stop to ask for a password; in a non-interactive run it would hang.
        GIT_TERMINAL_PROMPT: "0",
    });

    const toResult = (args: readonly string[], raw: ProcessResult): GitResult => ({
        args,
        exitCode: raw.timedOut ? GIT_TIMEOUT_EXIT_CODE : (raw.exitCode ?? 1),
        stdout: chomp(raw.stdout),
        stderr: raw.stderr.trim(),
        durationMs: raw.durationMs,
    });

    const check = (result: GitResult, raw: ProcessResult, options: GitRunOptions): GitResult => {
        if ((options.reject ?? true) && result.exitCode !== 0) {
            throw new GitError(result, { cwd: options.cwd, timedOut: raw.timedOut, timeoutMs: options.timeoutMs });
        }

        return result;
    };

    const processOptions = (args: readonly string[], options: GitRunOptions) => ({
        cwd: options.cwd,
        env: environmentFor(options),
        input: options.input,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        label: `git ${args[0] ?? ""}`.trim(),
    });

    const run: GitRunner["run"] = async (args, options) => {
        const raw = await deps.processes.run("git", args, processOptions(args, options));

        return check(toResult(args, raw), raw, options);
    };

    /** Runs a query: a failure means "no answer", not an error. */
    const ask = async (args: readonly string[], cwd: string): Promise<string | undefined> => {
        const result = await run(args, { cwd, reject: false });

        return result.exitCode === 0 && result.stdout.length > 0 ? result.stdout : undefined;
    };

    let configuredSsh: Promise<string | undefined> | undefined;

    /** The user's `core.sshCommand`, read once. Downloads run outside any repository, so only the global and system values apply. */
    const configuredSshCommand = (): Promise<string | undefined> => {
        configuredSsh ??= ask(["config", "--get", "core.sshCommand"], deps.env.TMPDIR ?? os.tmpdir());

        return configuredSsh;
    };

    /** What a download adds to git's environment so that ssh never asks on the terminal. */
    const downloadEnvironment = async (extra: Environment | undefined): Promise<Environment> => {
        const env: Environment = { ...deps.env, ...extra };

        // `GIT_SSH_COMMAND` would override a program the user named in `GIT_SSH`, so that one is left alone.
        if ((env.GIT_SSH ?? "") !== "") {
            return { ...extra };
        }

        const own = (env.GIT_SSH_COMMAND ?? "") !== "" ? env.GIT_SSH_COMMAND : await configuredSshCommand();
        const command = batchSshCommand(own);

        return command === undefined ? { ...extra } : { ...extra, GIT_SSH_COMMAND: command };
    };

    const lines = (text: string | undefined): string[] =>
        (text ?? "")
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);

    const runner: GitRunner = {
        run,

        runSync(args, options) {
            const raw = deps.processes.runSync("git", args, processOptions(args, options));

            return check(toResult(args, raw), raw, options);
        },

        async available() {
            return (await deps.processes.which("git", deps.env)) !== undefined;
        },

        async version() {
            const raw = await deps.processes.run("git", ["--version"], { env: environmentFor({}), label: "git --version" });

            return raw.exitCode === 0 ? /(\d+\.\d+(?:\.\d+)?)/.exec(raw.stdout)?.[1] : undefined;
        },

        root: (cwd) => ask(["rev-parse", "--show-toplevel"], cwd),

        // `symbolic-ref` fails on a detached head, which is what makes it the right question.
        currentBranch: (cwd) => ask(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd),

        async revParse(ref, cwd) {
            if (looksLikeOption(ref)) {
                return undefined;
            }

            return ask(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
        },

        async status(cwd) {
            const result = await run(["status", "--porcelain=v1", "-z"], { cwd });
            const parts = result.stdout.split("\0");
            const entries: GitStatusEntry[] = [];

            for (let index = 0; index < parts.length; index += 1) {
                const part = parts[index]!;

                if (part.length < 4) {
                    continue;
                }

                const code = part.slice(0, 2);
                const entryPath = part.slice(3);

                // A rename or copy is followed by the path it came from.
                if (code.includes("R") || code.includes("C")) {
                    entries.push({ path: entryPath, code, from: parts[index + 1] ?? "" });
                    index += 1;
                } else {
                    entries.push({ path: entryPath, code });
                }
            }

            return entries;
        },

        async tags(cwd, pattern) {
            const args = pattern === undefined ? ["tag", "--list"] : ["tag", "--list", pattern];

            return lines((await run(args, { cwd })).stdout);
        },

        async remoteUrl(cwd, remote = "origin") {
            return looksLikeOption(remote) ? undefined : ask(["remote", "get-url", remote], cwd);
        },

        async clone(url, directory, options = {}) {
            const parent = path.dirname(directory);
            const sparse = options.sparsePaths !== undefined && options.sparsePaths.length > 0;
            // Every clone keeps the committed bytes, whatever this machine's line-ending settings are.
            const args: string[] = ["clone", ...LF_CHECKOUT_OPTIONS];

            if (options.depth !== undefined && options.depth > 0) {
                args.push("--depth", String(options.depth));
            }

            if (sparse) {
                // Only the commit and the blobs inside the paths are downloaded.
                args.push("--filter=blob:none", "--sparse");
            }

            if (options.branch !== undefined) {
                args.push("--branch", options.branch);
            }

            if (options.noCheckout === true) {
                args.push("--no-checkout");
            }

            // Everything after `--` is a path or a URL, never an option, whatever it starts with.
            args.push("--", url, directory);
            await fs.mkdir(parent, { recursive: true });
            await run(args, { cwd: parent, env: await downloadEnvironment(options.env), timeoutMs: options.timeoutMs ?? GIT_DOWNLOAD_TIMEOUT_MS, signal: options.signal });

            if (sparse) {
                await run(["sparse-checkout", "set", "--", ...options.sparsePaths!], { cwd: directory, env: options.env, signal: options.signal });
            }
        },

        async readRemoteFile(url, filePath, options = {}) {
            if (looksLikeOption(url)) {
                throw new GitError({ args: ["fetch", url], exitCode: 1, stdout: "", stderr: `${url} is not a repository address.`, durationMs: 0 });
            }

            const ref = options.ref ?? "HEAD";
            const tmp = await fs.mkdtemp(path.join(deps.env.TMPDIR ?? os.tmpdir(), "sous-git-read-"));
            const common = { cwd: tmp, env: await downloadEnvironment(options.env), timeoutMs: options.timeoutMs ?? GIT_DOWNLOAD_TIMEOUT_MS, signal: options.signal };

            try {
                await run(["init", "--quiet"], common);
                await run(["remote", "add", "origin", "--", url], common);
                // One commit, and no files: only the one blob asked for is downloaded afterward.
                await run(["fetch", "--quiet", "--depth", "1", "--filter=blob:none", "origin", ref], common);

                const shown = await run(["show", `FETCH_HEAD:${filePath}`], { ...common, reject: false });

                if (shown.exitCode !== 0) {
                    throw new GitError(shown, { cwd: tmp });
                }

                return shown.stdout;
            } finally {
                await fs.rm(tmp, { recursive: true, force: true });
            }
        },
    };

    return runner;
}
