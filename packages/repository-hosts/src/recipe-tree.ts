/**
 * Fetching one recipe's folder at one tag, never the whole repository: a shallow, blobless, sparse
 * clone through `git.runner`, made beside the destination so moving it into place is a rename.
 */

import { cp, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "@sous-io/plugin-api";
import type { RecipeDownloadAttempt, RecipeDownloadProblem, RepositoryHostContext } from "@sous-io/plugin-recipes/types";
import type {} from "@sous-io/plugin-git/types";
import { firstLine } from "./http-strategy.js";

/** What to fetch. */
export interface RecipeTreeRequest {
    /** The clone URLs to try, in order: HTTPS, then SSH. */
    urls: readonly string[];
    tag: string;
    /** The recipe folder, relative to the repository root. */
    recipePath: string;
    /** Where its files end up; replaced when it exists. */
    destination: string;
}

/**
 * Fetches one folder at one tag into `destination`, trying each URL until one clones.
 *
 * ```ts
 * await fetchRecipeTree({
 *     urls: ["https://gitlab.com/acme/recipes.git", "git@gitlab.com:acme/recipes.git"],
 *     tag: "workflow/alpha@1.2.0",
 *     recipePath: "recipes/workflow/alpha",
 *     destination: "/home/me/.sous/cache/.../alpha",
 * }, ctx);
 * ```
 */
export async function fetchRecipeTree(request: RecipeTreeRequest, ctx: RepositoryHostContext): Promise<void> {
    const git = ctx.services.get("git.runner");
    const parent = path.dirname(request.destination);

    await mkdir(parent, { recursive: true });

    const work = await mkdtemp(path.join(parent, ".sous-fetch-"));

    try {
        const attempts: RecipeDownloadAttempt[] = [];

        for (const [index, url] of request.urls.entries()) {
            const checkout = path.join(work, `checkout-${index}`);

            try {
                await git.clone(url, checkout, {
                    branch: request.tag,
                    depth: 1,
                    sparsePaths: [request.recipePath],
                    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
                });
            } catch (error) {
                attempts.push(cloneAttempt(url, error));
                continue;
            }

            const source = path.join(checkout, request.recipePath);

            if (!(await isDirectory(source))) {
                throw new ConfigError(`The repository ${url} has no folder '${request.recipePath}' at the tag '${request.tag}'.`, {
                    details: ["Its index says the recipe lives there, so either the index is out of date or the tag points at the wrong commit."],
                });
            }

            await rm(request.destination, { recursive: true, force: true });
            await move(source, request.destination);

            return;
        }

        throw new RecipeDownloadError(`Could not fetch '${request.recipePath}' at the tag '${request.tag}'.`, attempts);
    } finally {
        await rm(work, { recursive: true, force: true });
    }
}

/**
 * A recipe that no clone URL could fetch. `details` holds one line per URL with git's reason, and
 * `attempts` says what kind of failure each was, so the caller can suggest a fix that fits.
 */
export class RecipeDownloadError extends ConfigError {
    readonly attempts: readonly RecipeDownloadAttempt[];

    constructor(message: string, attempts: readonly RecipeDownloadAttempt[]) {
        super(message, { details: attempts.map((attempt) => `${attempt.url}: ${attempt.reason}`) });
        this.attempts = attempts;
    }
}

/** Lines git prints that say nothing about why it failed. */
const GIT_NOISE = [/^Cloning into /, /^warning: /i, /^Please make sure you have the correct access rights/, /^and the repository exists\.?$/];

/**
 * Why one clone failed, from the error `git.runner` threw: git's own words in one line, and what
 * kind of failure they describe.
 *
 * ```ts
 * cloneAttempt("https://gitlab.com/acme/recipes.git", gitError);
 * // { url, host: "gitlab.com", problem: "credentials",
 * //   reason: "could not read Username for 'https://gitlab.com': terminal prompts disabled" }
 * ```
 */
export function cloneAttempt(url: string, error: unknown): RecipeDownloadAttempt {
    const host = hostOf(url);
    const { exitCode, stderr, timedOut } = gitOutcome(error);

    if (exitCode === GIT_NOT_FOUND_EXIT_CODE) {
        return { url, host, problem: "git-missing", reason: "git is not installed, or is not on your PATH" };
    }

    if (timedOut) {
        return { url, host, problem: "timeout", reason: "git did not finish in time and was stopped" };
    }

    const said = (stderr ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !GIT_NOISE.some((noise) => noise.test(line)))
        .map((line) => line.replace(/^(fatal|error): /i, "").replace(/\.$/, ""));
    const reason = said.length > 0 ? said.join("; ") : firstLine(error);

    return { url, host, problem: problemOf(reason), reason };
}

/** The exit code a command that could not start gets (`plugin-host`'s `NOT_FOUND_EXIT_CODE`). */
const GIT_NOT_FOUND_EXIT_CODE = 127;

/** What a `git.runner` error holds, read without depending on its class. */
function gitOutcome(error: unknown): { exitCode?: number; stderr?: string; timedOut: boolean } {
    const shaped = error as { result?: { exitCode?: unknown; stderr?: unknown }; timedOut?: unknown } | null;
    const result = typeof shaped === "object" && shaped !== null ? shaped.result : undefined;

    return {
        ...(typeof result?.exitCode === "number" ? { exitCode: result.exitCode } : {}),
        ...(typeof result?.stderr === "string" ? { stderr: result.stderr } : {}),
        timedOut: shaped?.timedOut === true,
    };
}

/** What kind of failure git's words describe. */
function problemOf(reason: string): RecipeDownloadProblem {
    if (/Remote branch .* not found|couldn't find remote ref|Could not find remote branch/i.test(reason)) {
        return "missing-tag";
    }

    if (/Could not resolve host|Connection refused|Connection timed out|Network is unreachable|Failed to connect|Operation timed out|Connection reset|No route to host|SSL/i.test(reason)) {
        return "network";
    }

    if (/could not read (Username|Password)|terminal prompts disabled|Authentication failed|Access denied|Permission denied|Host key verification failed|Repository not found|returned error: 40[13]|could not read from remote repository/i.test(reason)) {
        return "credentials";
    }

    return "other";
}

/** The host of an HTTPS or SSH clone URL: `https://gitlab.com/a/b.git` and `git@gitlab.com:a/b.git` give `gitlab.com`. */
function hostOf(url: string): string | undefined {
    const scp = /^[^/@]+@([^:/]+):/.exec(url);

    if (scp) {
        return scp[1];
    }

    try {
        return new URL(url).hostname || undefined;
    } catch {
        return undefined;
    }
}

/** Copies a folder out of a working tree, for a repository with no tag to clone. */
export async function copyRecipeTree(source: string, destination: string): Promise<void> {
    await rm(destination, { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true });
}

/** Whether a path is a directory. */
export async function isDirectory(candidate: string): Promise<boolean> {
    try {
        return (await stat(candidate)).isDirectory();
    } catch {
        return false;
    }
}

/** Moves a directory, copying when it crosses file systems. */
async function move(source: string, destination: string): Promise<void> {
    try {
        await rename(source, destination);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
            throw error;
        }

        await cp(source, destination, { recursive: true });
        await rm(source, { recursive: true, force: true });
    }
}
