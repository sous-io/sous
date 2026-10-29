/**
 * The contract of plugin-git (S6, "Shared building blocks"): the one git runner, used by every
 * caller (providers, releases, links, the runtime context). Other plugins import this file type-only.
 */

import type { Environment } from "@sous-io/plugin-api";

/** How to run one git command. */
export interface GitRunOptions {
    /** The working tree or repository the command runs in. */
    cwd: string;
    /** More environment variables (`GIT_TERMINAL_PROMPT=0` is always set). */
    env?: Environment;
    /** Text for standard input. */
    input?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Throws a `GitError`-shaped `SousError` when git exits non-zero. Default `true`. */
    reject?: boolean;
}

/** What one git command gave back. */
export interface GitResult {
    readonly args: readonly string[];
    readonly exitCode: number;
    /** Standard output, trailing newline removed. */
    readonly stdout: string;
    readonly stderr: string;
    readonly durationMs: number;
}

/** One entry of `git status --porcelain`. */
export interface GitStatusEntry {
    /** The path, relative to the working tree root. */
    readonly path: string;
    /** The two status letters (`M `, `??`, ` D`). */
    readonly code: string;
    /** The old path of a rename. */
    readonly from?: string;
}

/** Options for cloning. */
export interface GitCloneOptions {
    /** A branch or tag to check out. */
    branch?: string;
    /** Clone only this many commits. */
    depth?: number;
    /** Only these paths, through a sparse checkout. */
    sparsePaths?: readonly string[];
    /** Skips checking files out (`--no-checkout`). */
    noCheckout?: boolean;
    env?: Environment;
    signal?: AbortSignal;
}

/** Options for reading one file from a remote without a full clone (S4's `git` read strategy). */
export interface GitReadRemoteFileOptions {
    /** A branch, tag or `HEAD`. Default `HEAD`. */
    ref?: string;
    env?: Environment;
    timeoutMs?: number;
    signal?: AbortSignal;
}

/**
 * The one git runner (S6, `git.runner`): every call is timed (L5) and runs through
 * `host.processes`. Replaces both of today's `runGit` functions.
 */
export interface GitRunner {
    /** Runs git with arguments, asynchronously. */
    run(args: readonly string[], options: GitRunOptions): Promise<GitResult>;
    /** The same, blocking, for callers whose own interface is synchronous. */
    runSync(args: readonly string[], options: GitRunOptions): GitResult;
    /** Whether git is installed. */
    available(): Promise<boolean>;
    /** The installed git's version, such as `2.47.1`. */
    version(): Promise<string | undefined>;
    /** The top of the working tree holding `cwd`, or `undefined` outside one. */
    root(cwd: string): Promise<string | undefined>;
    /** The current branch, or `undefined` on a detached head. */
    currentBranch(cwd: string): Promise<string | undefined>;
    /** The commit a ref names. */
    revParse(ref: string, cwd: string): Promise<string | undefined>;
    /** The working tree's changes. */
    status(cwd: string): Promise<GitStatusEntry[]>;
    /** Every tag, optionally matching a pattern. */
    tags(cwd: string, pattern?: string): Promise<string[]>;
    /** The URL of a remote, or `undefined` when it does not exist. */
    remoteUrl(cwd: string, remote?: string): Promise<string | undefined>;
    /** Clones a repository into a directory. */
    clone(url: string, directory: string, options?: GitCloneOptions): Promise<void>;
    /** Reads one file from a remote repository, with the user's own credentials. */
    readRemoteFile(url: string, path: string, options?: GitReadRemoteFileOptions): Promise<string>;
}

declare module "@sous-io/plugin-api" {
    interface SousServices {
        /** The one git runner. */
        "git.runner": GitRunner;
    }
}
