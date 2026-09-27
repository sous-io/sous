/**
 * Which recipes take proposed changes, and which paths a change touches.
 *
 * A repository says which of its recipes do not take proposals with a
 * `submissions` block, on its repo manifest (covering every recipe) or on a
 * recipe manifest (covering that recipe, and winning over the repository's).
 * The motivating case is a recipe whose files are copied in from somewhere
 * else: a merged edit to the copy is overwritten by the next copy, and a
 * version it tagged can collide with the one the real source publishes.
 *
 * Two commands read it, with different strengths. `sous repo submit` warns,
 * prints where to go instead, and proposes anyway if the contributor carries
 * on: informed consent, not prevention. `sous repo release --check` fails a
 * pull request that changes such a recipe, because a pull request can be opened
 * without `submit`, and the check is the one gate every change passes.
 *
 * Nothing here decides a comparison base; the callers hand in the paths a
 * change touched, as git reported them.
 */

import path from "node:path";
import semver from "semver";
import { runGit, type RunOptions } from "../providers/git.js";
import { defaultBranch, forkPoint, pathsChangedSince } from "./git-state.js";
import { listRecipeTags, recipeTagKey } from "./tags.js";
import type { RepoValidation, ValidatedRecipe } from "./validate.js";

/** Whether one recipe takes proposals, and which manifest said so. */
export type SubmissionPolicy = {
  /** True when proposed changes to the recipe are accepted. */
  allowed: boolean;
  /** Where to send a change instead, when the manifest says. */
  instead?: string;
  /** Which manifest decided: the recipe's own, the repository's, or neither. */
  declaredBy: "recipe" | "repository" | "default";
};

/** A recipe a change touches although it does not take proposals. */
export type RefusingRecipe = {
  /** The recipe key, `namespace/name`. */
  key: string;
  /** The recipe folder, relative to the repository root. */
  path: string;
  /** Where to send the change instead, when the manifest says. */
  instead?: string;
  /** Which manifest said the recipe takes no proposals. */
  declaredBy: "recipe" | "repository";
  /** The changed paths inside the recipe folder, relative to the repository root. */
  changed: string[];
};

/**
 * Whether one recipe takes proposals. A recipe's own block wins over the
 * repository's; with neither, it does.
 *
 * submissionPolicy(validation, recipe);
 * // -> { allowed: false, instead: "Propose it upstream.", declaredBy: "recipe" }
 *
 * @param validation - The validated repository.
 * @param recipe - One of its recipes.
 */
export function submissionPolicy(
  validation: RepoValidation,
  recipe: ValidatedRecipe
): SubmissionPolicy {
  const own = recipe.manifest.submissions;
  if (own !== undefined) {
    return {
      allowed: own.allowed,
      ...(own.instead === undefined ? {} : { instead: own.instead }),
      declaredBy: "recipe",
    };
  }
  const repo = validation.manifest.submissions;
  if (repo !== undefined) {
    return {
      allowed: repo.allowed,
      ...(repo.instead === undefined ? {} : { instead: repo.instead }),
      declaredBy: "repository",
    };
  }
  return { allowed: true, declaredBy: "default" };
}

/**
 * The recipes a change touches that do not take proposals, in the order the
 * repo manifest lists them. A path is inside a recipe when it lies under the
 * recipe folder.
 *
 * recipesRefusingSubmissions(validation, ["recipes/core/x/a.md"]);
 * // -> [{ key: "core/x", path: "recipes/core/x", changed: ["recipes/core/x/a.md"], ... }]
 *
 * @param validation - The validated repository.
 * @param changedPaths - The paths the change touched, relative to the repository root.
 */
export function recipesRefusingSubmissions(
  validation: RepoValidation,
  changedPaths: ReadonlyArray<string>
): RefusingRecipe[] {
  const refusing: RefusingRecipe[] = [];
  for (const recipe of validation.recipes) {
    const policy = submissionPolicy(validation, recipe);
    if (policy.allowed || policy.declaredBy === "default") continue;

    const changed = pathsInside(recipe.path, changedPaths);
    if (changed.length === 0) continue;

    refusing.push({
      key: recipe.key,
      path: toPosix(recipe.path),
      ...(policy.instead === undefined ? {} : { instead: policy.instead }),
      declaredBy: policy.declaredBy,
      changed,
    });
  }
  return refusing;
}

/**
 * The paths from a list that lie inside a folder, both relative to the
 * repository root.
 *
 * pathsInside("recipes/core/x", ["recipes/core/x/a.md", "recipes/core/xy/b.md"]);
 * // -> ["recipes/core/x/a.md"]
 *
 * @param folder - The folder, relative to the repository root.
 * @param paths - The paths to test, relative to the repository root.
 */
export function pathsInside(folder: string, paths: ReadonlyArray<string>): string[] {
  const base = toPosix(path.posix.normalize(toPosix(folder))).replace(/\/+$/, "");
  return paths
    .map(toPosix)
    .filter((entry) => base === "." || entry === base || entry.startsWith(`${base}/`));
}

/** What the pull request check found about recipes that take no proposals. */
export type SubmissionsCheck = {
  /** The recipes the change touches although they take no proposals. */
  refusing: RefusingRecipe[];
  /**
   * What the change was compared with: the default branch it will merge into,
   * each recipe's last release tag when the checkout holds no copy of that
   * branch, or nothing at all when neither was there to compare with. `none
   * declined` means no recipe declines proposals, so there was nothing to check.
   */
  comparedWith:
    | { kind: "branch"; branch: string }
    | { kind: "tags" }
    | { kind: "nothing" }
    | { kind: "none declined" };
};

/**
 * The check `sous repo release --check` makes for a pull request: which recipes
 * that take no proposals the change touches.
 *
 * The change is what the checked-out commit holds beyond the point it shares
 * with the default branch on `origin`, which is exactly what a pull request
 * proposes. A checkout with no copy of that branch is compared recipe by recipe
 * with each one's last release tag instead: on the default branch a recipe
 * always equals its last tag, so a difference is a change nobody released.
 * A recipe that was never tagged has nothing to compare with and is left out.
 *
 * @param validation - The validated repository.
 * @param options - The command runner to use.
 */
export async function checkSubmissions(
  validation: RepoValidation,
  options: RunOptions = {}
): Promise<SubmissionsCheck> {
  const { rootDir } = validation;
  const guarded = validation.recipes.filter((recipe) => {
    const policy = submissionPolicy(validation, recipe);
    return !policy.allowed && policy.declaredBy !== "default";
  });
  if (guarded.length === 0) return { refusing: [], comparedWith: { kind: "none declined" } };

  const branch = (await defaultBranch(rootDir, options)) ?? "main";
  const since = await forkPoint(rootDir, "origin", branch, options);
  if (since !== undefined) {
    const changed = await pathsChangedSince(rootDir, since, options);
    return {
      refusing: recipesRefusingSubmissions(validation, changed),
      comparedWith: { kind: "branch", branch },
    };
  }

  const tags = await listRecipeTags(rootDir, options);
  const changed: string[] = [];
  let comparedAny = false;
  for (const recipe of guarded) {
    const versions = tags
      .filter((tag) => recipeTagKey(tag) === recipe.key && semver.valid(tag.version) !== null)
      .sort((left, right) => semver.rcompare(left.version, right.version));
    const last = versions[0];
    if (last === undefined) continue;
    comparedAny = true;
    const diff = await runGit(
      ["diff", "--name-only", last.tag, "HEAD", "--", toPosix(recipe.path)],
      { cwd: rootDir, run: options.run }
    );
    if (diff.length > 0) changed.push(...diff.split("\n").filter((line) => line.length > 0));
  }

  return {
    refusing: recipesRefusingSubmissions(validation, changed),
    comparedWith: comparedAny ? { kind: "tags" } : { kind: "nothing" },
  };
}

/** Rewrites a path with forward slashes, which is how git reports them. */
function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
