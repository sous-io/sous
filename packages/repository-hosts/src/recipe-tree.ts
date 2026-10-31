/**
 * Fetching one recipe's folder at one tag, never the whole repository: a shallow, blobless, sparse
 * clone through `git.runner`, made beside the destination so moving it into place is a rename.
 */

import { cp, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "@sous-io/plugin-api";
import type { RepositoryHostContext } from "@sous-io/plugin-recipes/types";
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
        const failures: string[] = [];

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
                failures.push(`${url}: ${firstLine(error)}`);
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

        throw new ConfigError(`Could not fetch '${request.recipePath}' at the tag '${request.tag}'.`, { details: failures });
    } finally {
        await rm(work, { recursive: true, force: true });
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
