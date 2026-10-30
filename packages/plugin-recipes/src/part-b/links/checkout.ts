/**
 * Editable checkouts: cloning a repository for `repo link`, reading what a checkout holds, and the
 * branch steps the link flags ask for. Every git command runs through `git.runner` (one runner,
 * timed). When git refuses a step, its own message is passed through under a line naming the step.
 */

import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "@sous-io/plugin-api";
import { LF_CHECKOUT_OPTIONS } from "@sous-io/plugin-git";
import type { GitResult, GitRunner } from "@sous-io/plugin-git/types";

/** The remote a clone creates, and the one every step here works on. */
export const UPSTREAM_REMOTE = "origin";

/** How long a step that asks upstream waits. */
export const UPSTREAM_CHECK_TIMEOUT_MS = 10_000;

/** Runs git without throwing on a non-zero exit. */
async function git(runner: GitRunner, args: readonly string[], cwd: string, timeoutMs?: number): Promise<GitResult> {
    return runner.run(args, { cwd, reject: false, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

/** Runs git, and throws a `ConfigError` naming the step when it fails. */
async function gitOrThrow(runner: GitRunner, args: readonly string[], cwd: string, what: string): Promise<GitResult> {
    const result = await git(runner, args, cwd);

    if (result.exitCode !== 0) {
        const said = (result.stderr || result.stdout).trim();

        throw new ConfigError(`${what} failed.`, {
            details: [`Command: git ${args.join(" ")}`, ...(said.length > 0 ? ["git said:", ...said.split("\n").map((line) => `  ${line}`)] : []), "Fix the problem git reported, then run the command again."],
        });
    }

    return result;
}

/** Whether a directory is the top of a git working tree. */
export async function isGitCheckout(runner: GitRunner, directory: string): Promise<boolean> {
    if (!isDirectory(directory)) {
        return false;
    }

    const result = await git(runner, ["rev-parse", "--show-toplevel"], directory);

    return result.exitCode === 0 && path.resolve(result.stdout.trim()) === path.resolve(directory);
}

/** The URL of the `origin` remote, or `undefined`. */
export async function remoteUrlOf(runner: GitRunner, directory: string): Promise<string | undefined> {
    const result = await git(runner, ["remote", "get-url", UPSTREAM_REMOTE], directory);

    return result.exitCode === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : undefined;
}

/** What a clone did. */
export interface CloneResult {
    readonly depth: number;
    /** True when the remote would not serve a shallow clone. */
    readonly fellBackToFullClone: boolean;
}

/** Clones a repository, shallow first, falling back to a full clone. Refuses a non-empty destination. */
export async function cloneRepo(runner: GitRunner, url: string, destination: string, depth = 1): Promise<CloneResult> {
    if (fs.existsSync(destination) && fs.readdirSync(destination).length > 0) {
        throw new ConfigError(`Cannot clone into ${destination}: the directory already exists and is not empty.`, {
            details: ["Move or delete it, or link the checkout that is already there by passing its path to 'sous repo link'."],
        });
    }

    const parent = path.dirname(destination);

    fs.mkdirSync(parent, { recursive: true });

    // A linked checkout is hashed when its recipes are released or compiled, so it keeps the
    // committed bytes whatever this machine's line-ending settings are.
    if (depth > 0) {
        const shallow = await git(runner, ["clone", ...LF_CHECKOUT_OPTIONS, "--depth", String(depth), "--", url, destination], parent);

        if (shallow.exitCode === 0) {
            return { depth, fellBackToFullClone: false };
        }

        fs.rmSync(destination, { recursive: true, force: true });
    }

    await gitOrThrow(runner, ["clone", ...LF_CHECKOUT_OPTIONS, "--", url, destination], parent, `Cloning ${url}`);

    return { depth: 0, fellBackToFullClone: depth > 0 };
}

/** Work in a checkout that exists nowhere else. */
export interface UnsavedWork {
    readonly uncommitted: string[];
    readonly unpushed: string[];
    readonly stashes: string[];
    /** Why the checkout could not be inspected. */
    readonly unknown?: string;
}

/** What a checkout holds that no remote has. */
export async function unsavedWork(runner: GitRunner, directory: string): Promise<UnsavedWork> {
    const status = await git(runner, ["status", "--porcelain"], directory);

    if (status.exitCode !== 0) {
        return { uncommitted: [], unpushed: [], stashes: [], unknown: `git could not read the checkout at ${directory}${status.stderr.trim() ? `: ${status.stderr.trim()}` : "."}` };
    }

    const unpushed = await git(runner, ["log", "--branches", "--not", "--remotes", "--oneline"], directory);
    const stashes = await git(runner, ["stash", "list"], directory);

    return {
        uncommitted: lines(status.stdout),
        unpushed: unpushed.exitCode === 0 ? lines(unpushed.stdout) : [],
        stashes: stashes.exitCode === 0 ? lines(stashes.stdout) : [],
    };
}

/** Whether nothing would be lost. */
export function hasNoUnsavedWork(work: UnsavedWork): boolean {
    return work.unknown === undefined && work.uncommitted.length === 0 && work.unpushed.length === 0 && work.stashes.length === 0;
}

/** Whether two remote URLs name the same repository, whatever their spelling. */
export function sameRemote(left: string, right: string): boolean {
    return normalizeRemoteUrl(left) === normalizeRemoteUrl(right);
}

/**
 * A remote URL without scheme, user, port, `.git` or trailing slashes, lowercased.
 *
 * ```ts
 * normalizeRemoteUrl("git@github.com:sous-io/sous.git"); // "github.com/sous-io/sous"
 * ```
 */
export function normalizeRemoteUrl(url: string): string {
    let value = url.trim();
    const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(value);

    if (scp !== null) {
        value = `${scp[1]}/${scp[2]}`;
    } else {
        value = value
            .replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "")
            .replace(/^[^/]*@/, "")
            .replace(/^([^/]+):\d+/, "$1");
    }

    return value.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}

/** The owner and name a checkout of a URL is cloned under: `<repos>/<owner>/<name>`. */
export function repoSlugFromUrl(url: string): { owner: string; name: string } {
    const segments = normalizeRemoteUrl(url)
        .split("/")
        .filter((segment) => segment.length > 0);

    if (segments.length < 2) {
        throw new ConfigError(`Could not work out an owner and a repository name from the URL '${url}'.`, {
            details: ["A repository URL looks like 'https://github.com/sous-io/sous-recipes'. Pass a path to 'sous repo link' to link a checkout already on disk."],
        });
    }

    const name = segments[segments.length - 1];
    const owner = segments.length >= 3 ? segments[segments.length - 2] : "repos";

    return { owner: sanitize(owner), name: sanitize(name) };
}

/** Whether text reads as a URL or an SCP-style remote rather than a short name. */
export function looksLikeRepoUrl(value: string): boolean {
    return value.includes("://") || /^[^@/\s]+@[^/\s:]+:/.test(value);
}

/** Whether text reads as a path on this machine. */
export function looksLikeLocalPath(value: string): boolean {
    return value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value === "." || value === ".." || value.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(value);
}

/** The branch checked out, or `undefined` on a detached head. */
export async function currentBranch(runner: GitRunner, directory: string): Promise<string | undefined> {
    const result = await git(runner, ["symbolic-ref", "--quiet", "--short", "HEAD"], directory);

    return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

/** The short commit checked out. */
export async function headCommit(runner: GitRunner, directory: string): Promise<string | undefined> {
    const result = await git(runner, ["rev-parse", "--short", "HEAD"], directory);

    return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

/** The upstream default branch: from `origin/HEAD`, else asking upstream. */
export async function defaultBranch(runner: GitRunner, directory: string): Promise<string | undefined> {
    const prefix = `${UPSTREAM_REMOTE}/`;
    const local = await git(runner, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${UPSTREAM_REMOTE}/HEAD`], directory);

    if (local.exitCode === 0 && local.stdout.trim().startsWith(prefix)) {
        return local.stdout.trim().slice(prefix.length);
    }

    const remote = await git(runner, ["ls-remote", "--symref", UPSTREAM_REMOTE, "HEAD"], directory, UPSTREAM_CHECK_TIMEOUT_MS);

    return remote.exitCode === 0 ? /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(remote.stdout)?.[1] : undefined;
}

/** Fetches upstream's refs; changes no file or branch. */
export async function tryFetchUpstream(runner: GitRunner, directory: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const result = await git(runner, ["fetch", "--quiet", UPSTREAM_REMOTE], directory, UPSTREAM_CHECK_TIMEOUT_MS);

    if (result.exitCode === 0) {
        return { ok: true };
    }

    const reason = (result.stderr || result.stdout).trim();

    return { ok: false, reason: reason.length > 0 ? reason : `git exited with status ${result.exitCode}` };
}

/** When the checkout last fetched, from git's own records. */
export async function lastFetchedAt(runner: GitRunner, directory: string, branch: string | undefined): Promise<Date | undefined> {
    const records = ["FETCH_HEAD", ...(branch === undefined ? [] : [`logs/refs/remotes/${UPSTREAM_REMOTE}/${branch}`])];
    let newest: Date | undefined;

    for (const record of records) {
        const located = await git(runner, ["rev-parse", "--git-path", record], directory);

        if (located.exitCode !== 0 || !located.stdout.trim()) {
            continue;
        }

        try {
            const modified = fs.statSync(path.resolve(directory, located.stdout.trim())).mtime;

            if (newest === undefined || modified > newest) {
                newest = modified;
            }
        } catch {
            // No such record.
        }
    }

    return newest;
}

/** How a checkout compares with upstream's default branch. */
export interface UpstreamComparison {
    readonly branch: string | undefined;
    readonly commit: string | undefined;
    readonly defaultBranch: string;
    readonly merged: boolean | undefined;
    readonly behind: number | undefined;
}

/** Compares HEAD with `origin/<branch>`. */
export async function compareWithUpstream(runner: GitRunner, directory: string, branch: string): Promise<UpstreamComparison> {
    const upstream = `${UPSTREAM_REMOTE}/${branch}`;
    const ancestor = await git(runner, ["merge-base", "--is-ancestor", "HEAD", upstream], directory);
    const count = await git(runner, ["rev-list", "--count", `HEAD..${upstream}`], directory);
    const behind = Number.parseInt(count.stdout.trim(), 10);

    return {
        branch: await currentBranch(runner, directory),
        commit: await headCommit(runner, directory),
        defaultBranch: branch,
        merged: ancestor.exitCode === 0 ? true : ancestor.exitCode === 1 ? false : undefined,
        behind: count.exitCode === 0 && Number.isFinite(behind) ? behind : undefined,
    };
}

/** Throws when a name is not a valid branch name. */
export async function assertBranchName(runner: GitRunner, directory: string, name: string): Promise<void> {
    await gitOrThrow(runner, ["check-ref-format", "--branch", name], directory, `Checking the branch name '${name}'`);
}

/** Whether a local branch exists. */
export async function localBranchExists(runner: GitRunner, directory: string, name: string): Promise<boolean> {
    return (await git(runner, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], directory)).exitCode === 0;
}

/** Fetches one branch from upstream, and makes later fetches cover it (a single-branch clone cannot see it otherwise). */
export async function fetchBranch(runner: GitRunner, directory: string, name: string): Promise<void> {
    await gitOrThrow(runner, ["fetch", "--quiet", UPSTREAM_REMOTE, `+refs/heads/${name}:refs/remotes/${UPSTREAM_REMOTE}/${name}`], directory, `Fetching the branch '${name}' from ${UPSTREAM_REMOTE}`);

    const config = await git(runner, ["config", "--get-all", `remote.${UPSTREAM_REMOTE}.fetch`], directory);
    const covered =
        config.exitCode === 0 &&
        config.stdout.split("\n").some((line) => {
            const source = line.trim().replace(/^\+/, "").split(":")[0];

            return source === "refs/heads/*" || source === `refs/heads/${name}`;
        });

    if (!covered) {
        await gitOrThrow(runner, ["remote", "set-branches", "--add", UPSTREAM_REMOTE, name], directory, `Adding the branch '${name}' to the branches ${UPSTREAM_REMOTE} is fetched for`);
    }
}

/** Switches to an existing branch. */
export async function switchBranch(runner: GitRunner, directory: string, name: string): Promise<void> {
    await gitOrThrow(runner, ["switch", name], directory, `Switching to the branch '${name}'`);
}

/** Creates a branch from a start point and switches to it. */
export async function createBranch(runner: GitRunner, directory: string, name: string, startPoint: string): Promise<void> {
    await gitOrThrow(runner, ["switch", "--create", name, "--no-track", startPoint], directory, `Creating the branch '${name}' from ${startPoint}`);
}

/** What making a branch match upstream's would discard. */
export interface DiscardableWork {
    readonly uncommitted: string[];
    readonly localCommits: string[];
}

/** Uncommitted changes, and commits on a branch upstream lacks. */
export async function discardableWork(runner: GitRunner, directory: string, name: string): Promise<DiscardableWork> {
    const status = await gitOrThrow(runner, ["status", "--porcelain", "--untracked-files=no"], directory, "Listing the uncommitted changes");
    let localCommits: string[] = [];

    if (await localBranchExists(runner, directory, name)) {
        const log = await gitOrThrow(
            runner,
            ["log", "--oneline", "--no-decorate", `refs/remotes/${UPSTREAM_REMOTE}/${name}..refs/heads/${name}`],
            directory,
            `Listing the commits on '${name}' that ${UPSTREAM_REMOTE} does not have`,
        );

        localCommits = lines(log.stdout);
    }

    return { uncommitted: lines(status.stdout), localCommits };
}

/** Makes a branch match upstream's, discarding local work. */
export async function resetBranchToUpstream(runner: GitRunner, directory: string, name: string): Promise<void> {
    await gitOrThrow(runner, ["switch", "--discard-changes", "--force-create", name, `${UPSTREAM_REMOTE}/${name}`], directory, `Making the branch '${name}' match ${UPSTREAM_REMOTE}/${name}`);
}

/** A generated branch name: `sous/edit-YYYYMMDD-HHMM`. */
export function generatedBranchName(now: Date = new Date()): string {
    const pad = (value: number): string => String(value).padStart(2, "0");

    return `sous/edit-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** Non-empty trimmed lines. */
function lines(text: string): string[] {
    return text
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.trim().length > 0);
}

/** A directory name safe to clone into. */
function sanitize(segment: string): string {
    const cleaned = segment.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^\.+/, "");

    return cleaned.length > 0 ? cleaned : "repo";
}

/** Whether a path is a directory. */
function isDirectory(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isDirectory();
    } catch {
        return false;
    }
}
