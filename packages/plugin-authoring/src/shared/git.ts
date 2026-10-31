/**
 * What git says about the checkout a release or a submission stands in, and the few writes they
 * make, all through the one git runner (`git.runner`). A release commits only its own version bumps
 * and index; a submission commits only when `--commit` asks it to. Everything else is read to refuse
 * politely rather than to fix anything.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GitRunner, GitStatusEntry } from "@sous-io/plugin-git/types";
import { toPosix } from "./repository.js";

/** The remote a repository is released to and contributed back to. */
export const UPSTREAM_REMOTE = "origin";

/** The remote name sous gives a fork it created. */
export const FORK_REMOTE = "fork";

/** One path git reports as changed. */
export interface ChangedPath {
    /** The two status letters, trimmed: `M`, `??`, `A`. */
    readonly status: string;
    readonly path: string;
}

/** What a push did: sent new commits, or found the remote already had them. */
export type PushOutcome = "updated" | "up-to-date";

/** Git, bound to one checkout. */
export class RepoGit {
    constructor(
        private readonly runner: GitRunner,
        readonly rootDir: string,
    ) {}

    /** Runs git, throwing when it fails; returns standard output. */
    async run(args: readonly string[]): Promise<string> {
        const result = await this.runner.run(args, { cwd: this.rootDir });

        return result.stdout.trim();
    }

    /** Runs git; returns standard output, or `undefined` when git failed. */
    async tryRun(args: readonly string[]): Promise<string | undefined> {
        const result = await this.runner.run(args, { cwd: this.rootDir, reject: false });

        return result.exitCode === 0 ? result.stdout.trim() : undefined;
    }

    /** Everything `git status` reports: staged, unstaged and untracked. Empty when clean. */
    async uncommittedChanges(): Promise<ChangedPath[]> {
        const entries: GitStatusEntry[] = await this.runner.status(this.rootDir);

        return entries.map((entry) => ({ status: entry.code.trim(), path: entry.path }));
    }

    /** The checked-out branch, or `undefined` on a detached head. */
    async currentBranch(): Promise<string | undefined> {
        return this.runner.currentBranch(this.rootDir);
    }

    /** The default branch, from what `origin/HEAD` points at; `undefined` when the clone was never told. */
    async defaultBranch(): Promise<string | undefined> {
        const ref = await this.tryRun(["symbolic-ref", "--short", `refs/remotes/${UPSTREAM_REMOTE}/HEAD`]);

        if (ref === undefined || ref.length === 0) {
            return undefined;
        }

        const slash = ref.indexOf("/");

        return slash === -1 ? ref : ref.slice(slash + 1);
    }

    /** The commit HEAD shares with a remote's branch, or `undefined` when this checkout holds no copy of it. */
    async forkPoint(remote: string, branch: string): Promise<string | undefined> {
        const commit = await this.tryRun(["merge-base", `refs/remotes/${remote}/${branch}`, "HEAD"]);

        return commit === undefined || commit.length === 0 ? undefined : commit;
    }

    /** Whether the commits since `since` changed a path. */
    async pathChangedSince(since: string, relativePath: string): Promise<boolean> {
        return (await this.run(["diff", "--name-only", since, "HEAD", "--", relativePath])).length > 0;
    }

    /** Every path the commits since `since` changed. */
    async pathsChangedSince(since: string, relativePath?: string): Promise<string[]> {
        const args = ["diff", "--name-only", since, "HEAD", ...(relativePath === undefined ? [] : ["--", relativePath])];

        return lines(await this.run(args));
    }

    /** A remote's URL, or `undefined`. */
    async remoteUrl(remote: string): Promise<string | undefined> {
        const url = await this.runner.remoteUrl(this.rootDir, remote);

        return url === undefined || url.length === 0 ? undefined : url;
    }

    /** Whether git can work out who is committing, which a commit and an annotated tag both need. */
    async hasCommitIdentity(): Promise<boolean> {
        for (const name of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
            const ident = await this.tryRun(["var", name]);

            if (ident === undefined || ident.length === 0) {
                return false;
            }
        }

        return true;
    }

    /** Stages exactly these paths and commits them; nothing else in the working tree is touched. */
    async commitPaths(paths: readonly string[], message: string): Promise<void> {
        if (paths.length === 0) {
            return;
        }

        await this.run(["add", "--", ...paths]);
        await this.run(["commit", "--message", message, "--", ...paths]);
    }

    /** Whether any of these paths differs from HEAD. */
    async anythingToCommit(paths: readonly string[]): Promise<boolean> {
        if (paths.length === 0) {
            return false;
        }

        return (await this.run(["status", "--porcelain", "--", ...paths])).length > 0;
    }

    /** Stages everything (edits, deletions, untracked files) and commits it. Only for `--commit`. */
    async commitEverything(message: string): Promise<void> {
        await this.run(["add", "--all"]);
        await this.run(["commit", "--quiet", "--message", message]);
    }

    /** Creates a branch at HEAD and checks it out. */
    async createBranch(branch: string): Promise<void> {
        await this.run(["checkout", "-b", branch]);
    }

    /** Whether a local branch exists. */
    async branchExists(branch: string): Promise<boolean> {
        return (await this.tryRun(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) !== undefined;
    }

    /** Checks out an existing branch; git's refusal reaches the caller unchanged. */
    async switchBranch(branch: string): Promise<void> {
        await this.run(["switch", branch]);
    }

    /**
     * Pushes one branch, setting its upstream, and says whether anything was sent. Never forced: when
     * the remote holds commits the local branch lacks, git's refusal is what the caller receives.
     */
    async pushBranch(remote: string, branch: string): Promise<PushOutcome> {
        const report = await this.run(["push", "--porcelain", "--set-upstream", remote, branch]);

        // Recorded so the checkout's own answer to "was this pushed?" stays true; a clone made by
        // `repo link` fetches only the default branch. A record, not a step.
        await this.tryRun(["update-ref", `refs/remotes/${remote}/${branch}`, `refs/heads/${branch}`]);

        return pushReportIsUpToDate(report) ? "up-to-date" : "updated";
    }

    /** Pushes exactly these tags. */
    async pushTags(remote: string, tags: readonly string[]): Promise<void> {
        if (tags.length === 0) {
            return;
        }

        await this.run(["push", remote, ...tags.map((tag) => `refs/tags/${tag}`)]);
    }

    /** Creates an annotated tag on HEAD. */
    async createAnnotatedTag(tag: string, message: string): Promise<void> {
        await this.run(["tag", "--annotate", tag, "--message", message]);
    }

    /** One file as it stood at a commit or tag, or `undefined` when it does not carry the file. */
    async readFileAt(ref: string, relativePath: string): Promise<string | undefined> {
        const result = await this.runner.run(["show", `${ref}:${toPosix(relativePath)}`], { cwd: this.rootDir, reject: false });

        return result.exitCode === 0 ? result.stdout : undefined;
    }

    /** When the commit a tag points at was made, as ISO 8601, or `undefined`. */
    async commitDate(ref: string): Promise<string | undefined> {
        const raw = await this.tryRun(["log", "-1", "--format=%cI", ref]);

        if (raw === undefined) {
            return undefined;
        }

        const parsed = new Date(raw);

        return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
    }

    /**
     * Checks the tree at a ref out into a temporary linked worktree, hands the caller one folder
     * inside it, and cleans up afterwards.
     */
    async withTree<T>(ref: string, subPath: string, use: (dir: string) => Promise<T>): Promise<T> {
        const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sous-release-"));
        const checkout = path.join(workRoot, "tree");

        try {
            await this.run(["worktree", "add", "--detach", "--quiet", checkout, ref]);

            return await use(path.join(checkout, ...toPosix(subPath).split("/")));
        } finally {
            // Through git first, so its record of the worktree goes too.
            await this.tryRun(["worktree", "remove", "--force", checkout]);
            await fs.rm(workRoot, { recursive: true, force: true });
        }
    }
}

/**
 * Whether git's machine-readable push report says every ref was already current.
 *
 * ```ts
 * pushReportIsUpToDate("To origin\n=\trefs/heads/a:refs/heads/a\t[up to date]\nDone");   // true
 * ```
 */
export function pushReportIsUpToDate(report: string): boolean {
    const refLines = report.split("\n").filter((line) => /^[ +\-*!=]\t/.test(line));

    return refLines.length > 0 && refLines.every((line) => line.startsWith("=\t"));
}

/**
 * The branch name sous proposes for a submission, stamped to the minute.
 *
 * ```ts
 * submitBranchName(new Date(2026, 9, 29, 14, 5));   // "sous/submit-20261029-1405"
 * ```
 */
export function submitBranchName(now: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

    return `sous/submit-${stamp}`;
}

/** The non-empty lines of a text. */
export function lines(text: string): string[] {
    return text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}
