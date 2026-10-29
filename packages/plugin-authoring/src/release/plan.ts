/**
 * The release plan: what one `repo release` run would do, worked out before anything is written.
 *
 * A release is decided by three facts about each recipe:
 *
 *   1. Is it in scope? By default every recipe is; `--namespace` and `--recipe` narrow it.
 *   2. Has its content changed since the tag that last published it?
 *   3. Has its version already been raised past that tag? Then this run only publishes it.
 *
 * From those, the plan says which manifests get a bump and which tags get cut, dependency-first.
 */

import path from "node:path";
import semver from "semver";
import type { ReleaseBump, ReleaseProblem } from "../types.js";
import type { AuthoringTools } from "../tools.js";
import type { RepoGit } from "../shared/git.js";
import { isNamedRef, keyOf, locationOf, namespaceNameOf, readingsOf } from "../shared/refs.js";
import { toPosix, type RepoValidation, type ValidatedRecipe } from "../shared/repository.js";
import { nextVersion } from "./bump.js";
import { listRecipeTags, tagOfKey, type RecipeTag } from "./tags.js";

/** Which recipes a run may touch. */
export interface ReleaseScope {
    /** Empty means every namespace. */
    readonly namespaces: string[];
    /** Recipe keys; empty means every recipe. */
    readonly recipes: string[];
}

/** What is known about one recipe before the plan is made. */
export interface RecipeState {
    readonly recipe: ValidatedRecipe;
    readonly key: string;
    /** The version its manifest declares. */
    readonly version: string;
    readonly inScope: boolean;
    /** The highest tagged version, when it was ever tagged. */
    readonly lastTagged?: string;
    readonly lastTag?: string;
    /** Whether its files differ from what that tag carries. */
    changed: boolean;
    /** Whether a tag exists for the declared version. */
    readonly currentVersionTagged: boolean;
}

/** One recipe the run would publish. */
export interface PlannedRelease {
    readonly key: string;
    /** The folder, relative to the root. */
    readonly path: string;
    readonly manifestPath: string;
    readonly from: string;
    readonly to: string;
    /** The bump the run applies, when it applies one. */
    readonly bump?: ReleaseBump;
    readonly tag: string;
    /** Why it is released. */
    readonly reason: "changed" | "included" | "first";
    /** The last released version, when there is one. */
    readonly lastTagged?: string;
}

/** One recipe the plan leaves alone. */
export interface SkippedRecipe {
    readonly key: string;
    /** A complete sentence. */
    readonly reason: string;
}

/** What a plan came to. */
export interface ReleasePlan {
    /** Dependency-first. */
    readonly releases: PlannedRelease[];
    readonly skipped: SkippedRecipe[];
    readonly problems: ReleaseProblem[];
    readonly tags: RecipeTag[];
    readonly states: RecipeState[];
}

/** What `buildReleasePlan` needs. */
export interface BuildReleasePlanOptions {
    readonly validation: RepoValidation;
    readonly scope: ReleaseScope;
    /** Default a patch step. */
    readonly bump?: ReleaseBump;
    /** Nothing is bumped, and an unbumped change is an error. */
    readonly noBump?: boolean;
    /** Every recipe in scope is released, changed or not. */
    readonly includeUnchanged?: boolean;
    readonly tags?: RecipeTag[];
}

/** The scope from the repeatable `--namespace` and `--recipe` flags. */
export function releaseScope(namespaces: readonly string[] = [], recipes: readonly string[] = []): ReleaseScope {
    const clean = (values: readonly string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];

    return { namespaces: clean(namespaces), recipes: clean(recipes) };
}

/** Whether the scope covers the whole repository. */
export function scopeIsWholeRepository(scope: ReleaseScope): boolean {
    return scope.namespaces.length === 0 && scope.recipes.length === 0;
}

/**
 * The scope in words.
 *
 * ```ts
 * describeScope(releaseScope(["workflow"]));   // "The namespace workflow"
 * ```
 */
export function describeScope(scope: ReleaseScope): string {
    if (scopeIsWholeRepository(scope)) {
        return "The whole repository";
    }

    const parts: string[] = [];

    if (scope.namespaces.length > 0) {
        parts.push(`${scope.namespaces.length === 1 ? "the namespace" : "the namespaces"} ${scope.namespaces.join(", ")}`);
    }

    if (scope.recipes.length > 0) {
        parts.push(`${scope.recipes.length === 1 ? "the recipe" : "the recipes"} ${scope.recipes.join(", ")}`);
    }

    return parts.join(", and ").replace(/^./, (first) => first.toUpperCase());
}

/** Scope entries that name nothing this repository publishes, so a typo is caught first. */
export function scopeProblems(validation: RepoValidation, scope: ReleaseScope): ReleaseProblem[] {
    const problems: ReleaseProblem[] = [];
    const keys = new Set(validation.recipes.map((recipe) => recipe.key));
    const namespaces = new Set(validation.recipes.map((recipe) => recipe.manifest.namespace));

    for (const namespace of scope.namespaces) {
        if (!namespaces.has(namespace)) {
            problems.push({
                level: "error",
                where: `--namespace ${namespace}`,
                message: `this repository publishes no namespace called '${namespace}'. It publishes: ${[...namespaces].sort().join(", ")}.`,
            });
        }
    }

    for (const key of scope.recipes) {
        if (!keys.has(key)) {
            problems.push({
                level: "error",
                where: `--recipe ${key}`,
                message: `this repository publishes no recipe called '${key}'. It publishes: ${[...keys].sort().join(", ")}.`,
            });
        }
    }

    return problems;
}

/** Works out what one run would publish. */
export async function buildReleasePlan(tools: AuthoringTools, git: RepoGit, options: BuildReleasePlanOptions): Promise<ReleasePlan> {
    const { validation, scope } = options;
    const tags = options.tags ?? (await listRecipeTags(git));
    const problems: ReleaseProblem[] = [];
    const states: RecipeState[] = [];

    for (const recipe of validation.recipes) {
        states.push(await readRecipeState(tools, git, recipe, scope, tags));
    }

    const releases: PlannedRelease[] = [];
    const skipped: SkippedRecipe[] = [];

    for (const state of states) {
        if (!state.inScope) {
            skipped.push({ key: state.key, reason: "it is outside this release's scope." });
            continue;
        }

        if (!state.changed && options.includeUnchanged !== true) {
            skipped.push({ key: state.key, reason: `its files have not changed since ${state.lastTag}.` });
            continue;
        }

        const reason = state.lastTagged === undefined ? "first" : state.changed ? "changed" : "included";
        const last = state.lastTagged === undefined ? {} : { lastTagged: state.lastTagged };

        // A version already raised past the last tag needs no bump; that is what a merge looks like to CI.
        if (state.lastTagged === undefined || !state.currentVersionTagged) {
            releases.push({
                key: state.key,
                path: state.recipe.path,
                manifestPath: state.recipe.manifestPath,
                from: state.version,
                to: state.version,
                tag: tagOfKey(state.key, state.version),
                reason,
                ...last,
            });
            continue;
        }

        if (options.noBump === true) {
            problems.push({
                level: "error",
                recipe: state.key,
                where: relativeTo(validation.rootDir, state.recipe.manifestPath),
                message:
                    `version ${state.version} is already published as the tag '${state.lastTag}', and this recipe's ` +
                    `files have changed since it. Raise the version in this manifest; a published version never changes.`,
            });
            continue;
        }

        const level = options.bump ?? "patch";
        const to = nextVersion(state.version, level);

        releases.push({
            key: state.key,
            path: state.recipe.path,
            manifestPath: state.recipe.manifestPath,
            from: state.version,
            to,
            bump: level,
            tag: tagOfKey(state.key, to),
            reason,
            ...last,
        });
    }

    const ordered = orderByDependencies(tools, releases, validation);

    problems.push(...checkSiblings(tools, validation, ordered, states));

    return { releases: ordered, skipped, problems, tags, states };
}

/**
 * Orders releases dependency-first, so a tag is never cut before the tags it depends on. Unrelated
 * recipes keep the repository manifest's order; a cycle keeps its original order.
 */
export function orderByDependencies(tools: AuthoringTools, releases: readonly PlannedRelease[], validation: RepoValidation): PlannedRelease[] {
    const byKey = new Map(releases.map((entry) => [entry.key, entry]));
    const ordered: PlannedRelease[] = [];
    const placed = new Set<string>();
    const visiting = new Set<string>();

    const place = (key: string): void => {
        if (placed.has(key) || visiting.has(key)) {
            return;
        }

        const entry = byKey.get(key);

        if (entry === undefined) {
            return;
        }

        visiting.add(key);

        for (const sibling of siblingKeysOf(tools, validation, key)) {
            place(sibling);
        }

        visiting.delete(key);
        placed.add(key);
        ordered.push(entry);
    };

    for (const entry of releases) {
        place(entry.key);
    }

    return ordered;
}

/**
 * The keys of the recipes in this repository a recipe depends on. A dependency written with a
 * location lives somewhere else and has nothing to do with the order tags are cut in here.
 */
export function siblingKeysOf(tools: AuthoringTools, validation: RepoValidation, key: string): string[] {
    const recipe = validation.recipes.find((entry) => entry.key === key);

    if (recipe === undefined) {
        return [];
    }

    const keys: string[] = [];

    for (const written of [...(recipe.manifest.depends ?? []), ...(recipe.manifest.subscribes ?? [])]) {
        const parsed = readingsOf(tools, written)?.[0];

        if (parsed === undefined || !isNamedRef(parsed) || locationOf(tools, parsed) !== undefined) {
            continue;
        }

        if (parsed.kind === "recipe") {
            keys.push(keyOf(tools, parsed));
            continue;
        }

        // A whole-namespace dependency means every recipe in it.
        const namespace = namespaceNameOf(tools, parsed);

        for (const entry of validation.recipes) {
            if (entry.manifest.namespace === namespace && entry.key !== key) {
                keys.push(entry.key);
            }
        }
    }

    return [...new Set(keys)];
}

/**
 * The sibling rule: everything a released recipe depends on here must exist once this run's tags
 * count. A sibling never tagged is an error; one tagged and changed since, outside the scope, is a
 * warning, since the release then depends on its last tag.
 */
function checkSiblings(tools: AuthoringTools, validation: RepoValidation, releases: readonly PlannedRelease[], states: readonly RecipeState[]): ReleaseProblem[] {
    const problems: ReleaseProblem[] = [];
    const releasing = new Set(releases.map((entry) => entry.key));
    const byKey = new Map(states.map((state) => [state.key, state]));

    for (const release of releases) {
        for (const siblingKey of siblingKeysOf(tools, validation, release.key)) {
            if (releasing.has(siblingKey)) {
                continue;
            }

            const sibling = byKey.get(siblingKey);
            const where = relativeTo(validation.rootDir, release.manifestPath);

            if (sibling === undefined) {
                problems.push({
                    level: "error",
                    recipe: release.key,
                    where,
                    message:
                        `it depends on '${siblingKey}', which this repository does not publish. A dependency written ` +
                        `without a location names a recipe in this same repository.`,
                });
            } else if (sibling.lastTagged === undefined) {
                problems.push({
                    level: "error",
                    recipe: release.key,
                    where,
                    message:
                        `it depends on '${siblingKey}', which has never been published: this repository carries no tag ` +
                        `for it. Release it first, which cuts the tag '${tagOfKey(siblingKey, sibling.version)}'.`,
                });
            } else if (sibling.changed) {
                problems.push({
                    level: "warning",
                    recipe: release.key,
                    where,
                    message:
                        `'${siblingKey}' has changes since '${sibling.lastTag}' that are outside this release's scope; ` +
                        `'${release.tag}' will depend on '${sibling.lastTag}'.`,
                });
            }
        }
    }

    return problems;
}

async function readRecipeState(
    tools: AuthoringTools,
    git: RepoGit,
    recipe: ValidatedRecipe,
    scope: ReleaseScope,
    tags: readonly RecipeTag[],
): Promise<RecipeState> {
    const key = recipe.key;
    const version = recipe.manifest.version;
    const mine = tags.filter((tag) => `${tag.namespace}/${tag.name}` === key);
    const highest = mine
        .map((tag) => tag.version)
        .filter((value) => semver.valid(value) !== null)
        .sort((left, right) => semver.rcompare(left, right))[0];

    const state: RecipeState = {
        recipe,
        key,
        version,
        inScope: coveredByScope(recipe, scope),
        changed: true,
        currentVersionTagged: mine.some((tag) => tag.version === version),
        ...(highest === undefined ? {} : { lastTagged: highest, lastTag: tagOfKey(key, highest) }),
    };

    if (highest === undefined) {
        return state;
    }

    // "Changed" is a content question, answered by hashing, as a consumer checks a cached copy.
    const workingHash = await tools.hash.hashDirectory(recipe.dir);
    const taggedHash = await git.withTree(tagOfKey(key, highest), recipe.path, (dir) => tools.hash.hashDirectory(dir));

    state.changed = !tools.hash.equal(workingHash, taggedHash);

    return state;
}

function coveredByScope(recipe: ValidatedRecipe, scope: ReleaseScope): boolean {
    return scopeIsWholeRepository(scope) || scope.namespaces.includes(recipe.manifest.namespace) || scope.recipes.includes(recipe.key);
}

function relativeTo(rootDir: string, target: string): string {
    return toPosix(path.relative(rootDir, target));
}
