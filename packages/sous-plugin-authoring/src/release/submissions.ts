/**
 * Which recipes take proposed changes, and which of them a change touches. A repository says so with
 * a `submissions` block, on its repository manifest (every recipe) or on a recipe manifest (that
 * recipe, winning over the repository's). `repo submit` warns and proposes anyway when the
 * contributor carries on; `repo release --check` fails a pull request that changes such a recipe.
 */

import path from "node:path";
import semver from "semver";
import type { RepoGit } from "../shared/git.js";
import { lines, UPSTREAM_REMOTE } from "../shared/git.js";
import { toPosix, type RepoValidation, type ValidatedRecipe } from "../shared/repository.js";
import { listRecipeTags, recipeTagKey } from "./tags.js";

/** Whether one recipe takes proposals, and which manifest said so. */
export interface SubmissionPolicy {
    readonly allowed: boolean;
    readonly instead?: string;
    readonly declaredBy: "recipe" | "repository" | "default";
}

/** A recipe a change touches although it takes no proposals. */
export interface RefusingRecipe {
    readonly key: string;
    readonly path: string;
    readonly instead?: string;
    readonly declaredBy: "recipe" | "repository";
    /** The changed paths inside it, relative to the root. */
    readonly changed: string[];
}

/** What the pull request check found. */
export interface SubmissionsCheck {
    readonly refusing: RefusingRecipe[];
    /** What the change was compared with. */
    readonly comparedWith: { kind: "branch"; branch: string } | { kind: "tags" } | { kind: "nothing" } | { kind: "none declined" };
}

/** Whether one recipe takes proposals: its own block, else the repository's, else yes. */
export function submissionPolicy(validation: RepoValidation, recipe: ValidatedRecipe): SubmissionPolicy {
    const own = recipe.manifest.submissions;

    if (own !== undefined) {
        return { allowed: own.allowed, ...(own.instead === undefined ? {} : { instead: own.instead }), declaredBy: "recipe" };
    }

    const repo = validation.manifest.submissions;

    if (repo !== undefined) {
        return { allowed: repo.allowed, ...(repo.instead === undefined ? {} : { instead: repo.instead }), declaredBy: "repository" };
    }

    return { allowed: true, declaredBy: "default" };
}

/** The recipes a change touches that take no proposals, in manifest order. */
export function recipesRefusingSubmissions(validation: RepoValidation, changedPaths: readonly string[]): RefusingRecipe[] {
    const refusing: RefusingRecipe[] = [];

    for (const recipe of validation.recipes) {
        const policy = submissionPolicy(validation, recipe);

        if (policy.allowed || policy.declaredBy === "default") {
            continue;
        }

        const changed = pathsInside(recipe.path, changedPaths);

        if (changed.length > 0) {
            refusing.push({
                key: recipe.key,
                path: toPosix(recipe.path),
                ...(policy.instead === undefined ? {} : { instead: policy.instead }),
                declaredBy: policy.declaredBy,
                changed,
            });
        }
    }

    return refusing;
}

/**
 * The paths that lie inside a folder, both relative to the root.
 *
 * ```ts
 * pathsInside("recipes/core/x", ["recipes/core/x/a.md", "recipes/core/xy/b.md"]);   // ["recipes/core/x/a.md"]
 * ```
 */
export function pathsInside(folder: string, paths: readonly string[]): string[] {
    const base = toPosix(path.posix.normalize(toPosix(folder))).replace(/\/+$/, "");

    return paths.map(toPosix).filter((entry) => base === "." || entry === base || entry.startsWith(`${base}/`));
}

/**
 * The check `repo release --check` makes for a pull request: what the checked-out commit holds beyond
 * the point it shares with the default branch, or, without a copy of that branch, each guarded recipe
 * compared with its last release tag.
 */
export async function checkSubmissions(git: RepoGit, validation: RepoValidation): Promise<SubmissionsCheck> {
    const guarded = validation.recipes.filter((recipe) => {
        const policy = submissionPolicy(validation, recipe);

        return !policy.allowed && policy.declaredBy !== "default";
    });

    if (guarded.length === 0) {
        return { refusing: [], comparedWith: { kind: "none declined" } };
    }

    const branch = (await git.defaultBranch()) ?? "main";
    const since = await git.forkPoint(UPSTREAM_REMOTE, branch);

    if (since !== undefined) {
        return { refusing: recipesRefusingSubmissions(validation, await git.pathsChangedSince(since)), comparedWith: { kind: "branch", branch } };
    }

    const tags = await listRecipeTags(git);
    const changed: string[] = [];
    let comparedAny = false;

    for (const recipe of guarded) {
        const last = tags
            .filter((tag) => recipeTagKey(tag) === recipe.key && semver.valid(tag.version) !== null)
            .sort((left, right) => semver.rcompare(left.version, right.version))[0];

        if (last === undefined) {
            continue;
        }

        comparedAny = true;
        changed.push(...lines(await git.run(["diff", "--name-only", last.tag, "HEAD", "--", toPosix(recipe.path)])));
    }

    return { refusing: recipesRefusingSubmissions(validation, changed), comparedWith: comparedAny ? { kind: "tags" } : { kind: "nothing" } };
}
