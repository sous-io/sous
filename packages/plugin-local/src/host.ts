/**
 * The `local` repository-host entity: a recipe repository on this machine, for local development
 * and tests. It is read the way a hosted repository is, so trust, the resolver, the store and the
 * build run unchanged and without a network. Trust is the same as for any repository: a local path
 * is added, and so trusted, the same way.
 *
 * ```text
 * Read strategies    file: the working tree's copy, so an index being written is seen
 *                    git:  git show <ref>:<path>, the committed copy
 * ```
 *
 * A recipe's files come from a sparse clone of the local path at the tag; a directory that is not
 * a git repository, or has no such tag, has its folder copied from the working tree instead.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ConfigError } from "@sous-io/plugin-api";
import type { RepositoryHostContext, RepositoryReadStrategy } from "@sous-io/plugin-recipes/types";
import { copyRecipeTree, fetchRecipeTree, formatHostedLocator, gitFailureReason, type CanonicalRepository } from "@sous-io/repository-hosts";
import { localRepoPath } from "./paths.js";
import { assertLocalRepoDirectory } from "./repo-directory.js";
import type { LocalRepositoryHost } from "./types.js";

/** The host every local repository is filed under. */
export const LOCAL_HOST = "localhost";

/** The directory a canonical local repository names (kept in `httpsUrl`, which git is handed). */
export function repoDirectory(repository: CanonicalRepository): string {
    return repository.httpsUrl;
}

/** Reads the working tree's copy, for `HEAD` only. */
const fileStrategy: RepositoryReadStrategy = {
    id: "file",
    label: "working tree",

    async read(request) {
        const directory = repoDirectory(request.repository);

        if (request.ref !== "HEAD") {
            return { ok: false, reason: `the working tree is not ${request.ref}` };
        }

        if (!existsSync(directory)) {
            return { ok: false, reason: `there is no directory at ${directory}` };
        }

        const file = path.join(directory, request.path);

        if (!existsSync(file)) {
            return { ok: false, reason: `the working tree has no ${request.path}` };
        }

        return { ok: true, text: await readFile(file, "utf8"), ref: "working tree" };
    },
};

/** Reads the committed copy with `git show`. */
const gitStrategy: RepositoryReadStrategy = {
    id: "git",
    label: "git",

    async read(request, ctx) {
        const directory = repoDirectory(request.repository);

        if (!existsSync(directory)) {
            return { ok: false, reason: `there is no directory at ${directory}` };
        }

        const result = await ctx.services.get("git.runner").run(["show", `${request.ref}:${request.path}`], {
            cwd: directory,
            reject: false,
            ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        });

        if (result.exitCode !== 0) {
            return { ok: false, reason: gitFailureReason(new Error(result.stderr || "git show failed")) };
        }

        return { ok: true, text: result.stdout, ref: request.ref };
    },
};

/**
 * Builds the entity.
 *
 * ```ts
 * createLocalHost().canonicalize("file:///home/me/recipes");
 * // { host: "localhost", owner: "/home/me", name: "recipes", httpsUrl: "/home/me/recipes", sshUrl: "file:///home/me/recipes" }
 * ```
 */
export function createLocalHost(): LocalRepositoryHost {
    return {
        id: "local",
        // Proposing a change to a directory on your own disk is just editing it.
        features: ["fetch"],

        readLocation: () => [],
        formatLocator: (host, repoPath, rest) => formatHostedLocator("local", undefined, host, repoPath, rest),

        matches: (url) => localRepoPath(url) !== undefined,

        canonicalize(url) {
            const directory = localRepoPath(url);

            if (directory === undefined) {
                throw new ConfigError(`'${url}' is not a local repository path that sous can read.`, {
                    details: [
                        "A local repository is named by an absolute path, or by the same path in 'file:///...' form. A relative path is not accepted, because a repository entry is read from a config file that several working directories may run against.",
                    ],
                });
            }

            return {
                host: LOCAL_HOST,
                owner: path.dirname(directory),
                name: path.basename(directory),
                httpsUrl: directory,
                sshUrl: pathToFileURL(directory).href,
            };
        },

        readStrategies: [fileStrategy, gitStrategy],

        checkTypedPath: (typed, resolved, ctx) => assertLocalRepoDirectory(typed, resolved, ctx.services.get("formats.manifests")),

        fetchRecipeTree: (repository, recipePath, tag, destination, ctx) => fetchLocalRecipeTree(repository, recipePath, tag, destination, ctx),
    };
}

/** A git repository holding the tag is cloned at it; anything else has its working tree copied. */
async function fetchLocalRecipeTree(
    repository: CanonicalRepository,
    recipePath: string,
    tag: string,
    destination: string,
    ctx: RepositoryHostContext,
): Promise<void> {
    const directory = repoDirectory(repository);
    const git = ctx.services.get("git.runner");

    if ((await git.root(directory)) !== undefined && (await git.revParse(`refs/tags/${tag}`, directory)) !== undefined) {
        await fetchRecipeTree({ urls: [directory], tag, recipePath, destination }, ctx);

        return;
    }

    const source = path.join(directory, recipePath);

    if (!existsSync(source)) {
        throw new ConfigError(`The repository at ${directory} has no folder '${recipePath}'.`, {
            details: ["Its index says the recipe lives there, so either the index is out of date or the folder has been moved."],
        });
    }

    await copyRecipeTree(source, destination);
}
