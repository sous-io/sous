/**
 * The release plan: what one `sous repo release` run would do, worked out
 * before anything is written.
 *
 * A release is decided by three facts about each recipe, and nothing else:
 *
 *   1. Is it IN SCOPE? By default every recipe the repository publishes is;
 *      `--namespace` and `--recipe` narrow it.
 *   2. Has its content CHANGED since the tag that last published it? A recipe
 *      nobody touched is not re-released, because a published version that says
 *      the same thing as the one before it is noise.
 *   3. Has its version already been RAISED past that tag? If so the author (or
 *      a previous run) has already done the bump, and this run only publishes
 *      it.
 *
 * From those, the plan says which manifests get a version bump, which tags get
 * cut, and in which order: dependency-first, so a recipe is never published
 * before something it depends on.
 *
 * Nothing here writes anything. The command prints the plan, asks once, and
 * then carries it out.
 */

import path from "node:path";
import semver from "semver";
import { hashDirectory } from "../store/hash.js";
import { parseDependencyRef } from "../ref.js";
import type { RunOptions } from "../providers/git.js";
import { listRecipeTags, tagFor, withTaggedTree, type RecipeTag } from "./tags.js";
import { nextVersion, type BumpLevel } from "./bump.js";
import type { RepoValidation, ValidatedRecipe, ValidationProblem } from "./validate.js";

/** Which recipes a run is allowed to touch. */
export type ReleaseScope = {
  /** Namespaces named with `--namespace`. Empty means every namespace. */
  namespaces: string[];
  /** Recipe keys named with `--recipe`. Empty means every recipe. */
  recipes: string[];
};

/** What is known about one recipe before the plan is made. */
export type RecipeState = {
  /** The validated recipe. */
  recipe: ValidatedRecipe;
  /** Its key, `namespace/name`. */
  key: string;
  /** The version its manifest declares right now. */
  version: string;
  /** Whether the scope covers it. */
  inScope: boolean;
  /** The highest version any tag publishes, when the recipe has ever been tagged. */
  lastTagged?: string;
  /** The tag carrying that version. */
  lastTag?: string;
  /** Whether the recipe's files differ from what that tag carries. */
  changed: boolean;
  /** Whether a tag already exists for the version the manifest declares. */
  currentVersionTagged: boolean;
};

/** One recipe this run would publish. */
export type PlannedRelease = {
  /** The recipe key, `namespace/name`. */
  key: string;
  /** The recipe folder, relative to the repository root. */
  path: string;
  /** Absolute path to the recipe's manifest, which a bump rewrites. */
  manifestPath: string;
  /** The version the manifest declares now. */
  from: string;
  /** The version this run publishes. */
  to: string;
  /** The bump this run applies, when it applies one. */
  bump?: BumpLevel;
  /** The tag this run would cut. */
  tag: string;
};

/** One recipe the plan leaves alone, and why. */
export type SkippedRecipe = {
  key: string;
  /** A complete sentence, ready to print. */
  reason: string;
};

/** What a plan came to. */
export type ReleasePlan = {
  /** Everything this run would publish, dependency-first. */
  releases: PlannedRelease[];
  /** Recipes the run leaves alone, with the reason for each. */
  skipped: SkippedRecipe[];
  /** Everything wrong with the plan, errors and warnings together. */
  problems: ValidationProblem[];
  /** Every release tag the repository carries. */
  tags: RecipeTag[];
  /** What each recipe looked like when the plan was made. */
  states: RecipeState[];
};

/** What `buildReleasePlan` needs to know. */
export type BuildReleasePlanOptions = {
  /** The validated repository. */
  validation: RepoValidation;
  /** Which recipes the run may touch. */
  scope: ReleaseScope;
  /** How far to raise a changed recipe's version. Defaults to a patch step. */
  bump?: BumpLevel;
  /** When true, nothing is bumped and an unbumped change is an error. */
  noBump?: boolean;
  /** When true, every recipe in scope is released, changed or not. */
  includeUnchanged?: boolean;
  /** Every release tag, when the caller has already listed them. */
  tags?: RecipeTag[];
  /** The command runner git calls go through. */
  run?: RunOptions["run"];
};

/**
 * Builds the scope from the repeatable `--namespace` and `--recipe` flags.
 *
 * @param namespaces - Namespaces named on the command line.
 * @param recipes - Recipe keys named on the command line.
 */
export function releaseScope(
  namespaces: string[] = [],
  recipes: string[] = []
): ReleaseScope {
  return {
    namespaces: [...new Set(namespaces.map((value) => value.trim()).filter(Boolean))],
    recipes: [...new Set(recipes.map((value) => value.trim()).filter(Boolean))],
  };
}

/** True when the scope covers every recipe the repository publishes. */
export function scopeIsWholeRepository(scope: ReleaseScope): boolean {
  return scope.namespaces.length === 0 && scope.recipes.length === 0;
}

/**
 * The scope in words, for the run's preamble.
 *
 * @param scope - The scope to describe.
 */
export function describeScope(scope: ReleaseScope): string {
  if (scopeIsWholeRepository(scope)) return "The whole repository";
  const parts: string[] = [];
  if (scope.namespaces.length > 0) {
    parts.push(
      `${scope.namespaces.length === 1 ? "the namespace" : "the namespaces"} ` +
        scope.namespaces.join(", ")
    );
  }
  if (scope.recipes.length > 0) {
    parts.push(
      `${scope.recipes.length === 1 ? "the recipe" : "the recipes"} ` +
        scope.recipes.join(", ")
    );
  }
  return parts.join(", and ").replace(/^./, (first) => first.toUpperCase());
}

/**
 * Raises a ConfigError-free list of problems for scope entries that name
 * nothing this repository publishes, so a typo is caught before anything runs.
 *
 * @param validation - The validated repository.
 * @param scope - The scope as given.
 */
export function scopeProblems(
  validation: RepoValidation,
  scope: ReleaseScope
): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const keys = new Set(validation.recipes.map((recipe) => recipe.key));
  const namespaces = new Set(
    validation.recipes.map((recipe) => recipe.manifest.namespace)
  );

  for (const namespace of scope.namespaces) {
    if (namespaces.has(namespace)) continue;
    problems.push({
      level: "error",
      where: `--namespace ${namespace}`,
      message:
        `this repository publishes no namespace called '${namespace}'. It publishes: ` +
        `${[...namespaces].sort().join(", ")}.`,
    });
  }

  for (const key of scope.recipes) {
    if (keys.has(key)) continue;
    problems.push({
      level: "error",
      where: `--recipe ${key}`,
      message:
        `this repository publishes no recipe called '${key}'. It publishes: ` +
        `${[...keys].sort().join(", ")}.`,
    });
  }

  return problems;
}

/**
 * Works out what one run would publish.
 *
 * @param options - The validated repository, the scope, and the bump rules.
 */
export async function buildReleasePlan(
  options: BuildReleasePlanOptions
): Promise<ReleasePlan> {
  const { validation, scope } = options;
  const run = options.run;
  const tags = options.tags ?? (await listRecipeTags(validation.rootDir, { run }));
  const problems: ValidationProblem[] = [];

  const states: RecipeState[] = [];
  for (const recipe of validation.recipes) {
    states.push(await readRecipeState(validation.rootDir, recipe, scope, tags, run));
  }

  const releases: PlannedRelease[] = [];
  const skipped: SkippedRecipe[] = [];

  for (const state of states) {
    if (!state.inScope) {
      skipped.push({
        key: state.key,
        reason: "it is outside this release's scope.",
      });
      continue;
    }

    const worthReleasing = state.changed || options.includeUnchanged === true;
    if (!worthReleasing) {
      skipped.push({
        key: state.key,
        reason: `its files have not changed since ${state.lastTag}.`,
      });
      continue;
    }

    // A version already raised past the last tag needs no bump; this run only
    // publishes it. That is what a merge commit looks like to the CI run.
    const alreadyRaised = state.lastTagged === undefined || !state.currentVersionTagged;

    if (alreadyRaised) {
      releases.push({
        key: state.key,
        path: state.recipe.path,
        manifestPath: state.recipe.manifestPath,
        from: state.version,
        to: state.version,
        tag: tagOf(state.key, state.version),
      });
      continue;
    }

    if (options.noBump === true) {
      problems.push({
        level: "error",
        where: relativeTo(validation.rootDir, state.recipe.manifestPath),
        message:
          `version ${state.version} is already published as the tag '${state.lastTag}', ` +
          `and this recipe's files have changed since it. Raise the version in this ` +
          `manifest; a published version never changes.`,
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
      tag: tagOf(state.key, to),
    });
  }

  const ordered = orderByDependencies(releases, validation);
  problems.push(...checkSiblings(validation, ordered, states));

  return { releases: ordered, skipped, problems, tags, states };
}

/**
 * Orders a set of releases dependency-first, so a tag is never cut before the
 * tags it will depend on. Recipes that do not depend on each other keep their
 * original order, which is the order the repo manifest lists them in.
 *
 * A cycle cannot be ordered; the entries in it keep their original order, and
 * the closure check that follows reports it as the real problem.
 *
 * @param releases - The releases to order.
 * @param validation - The validated repository, read for each manifest's siblings.
 */
export function orderByDependencies(
  releases: PlannedRelease[],
  validation: RepoValidation
): PlannedRelease[] {
  const byKey = new Map(releases.map((entry) => [entry.key, entry]));
  const ordered: PlannedRelease[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();

  const place = (key: string): void => {
    if (placed.has(key) || visiting.has(key)) return;
    const entry = byKey.get(key);
    if (entry === undefined) return;

    visiting.add(key);
    for (const sibling of siblingKeysOf(validation, key)) place(sibling);
    visiting.delete(key);

    placed.add(key);
    ordered.push(entry);
  };

  for (const entry of releases) place(entry.key);
  return ordered;
}

/**
 * The keys of the recipes in THIS repository that a recipe depends on. A
 * dependency written as a locator URL lives somewhere else and has nothing to
 * do with the order tags are cut in here.
 *
 * @param validation - The validated repository.
 * @param key - The recipe whose dependencies are wanted.
 */
export function siblingKeysOf(validation: RepoValidation, key: string): string[] {
  const recipe = validation.recipes.find((entry) => entry.key === key);
  if (recipe === undefined) return [];

  const declared = [
    ...(recipe.manifest.depends ?? []),
    ...(recipe.manifest.subscribes ?? []),
  ];

  const keys: string[] = [];
  for (const written of declared) {
    let parsed;
    try {
      parsed = parseDependencyRef(written);
    } catch {
      continue;
    }
    if (parsed.kind !== "sibling") continue;

    if (parsed.recipe !== undefined) {
      keys.push(`${parsed.namespace}/${parsed.recipe}`);
      continue;
    }
    // A whole-namespace dependency means every recipe in it.
    for (const entry of validation.recipes) {
      if (entry.manifest.namespace === parsed.namespace && entry.key !== key) {
        keys.push(entry.key);
      }
    }
  }

  return [...new Set(keys)];
}

/**
 * Checks the sibling rule: everything a released recipe depends on inside this
 * repository has to be a version that exists once this run's own tags are
 * counted.
 *
 * There are exactly two ways that fails, and they are different kinds of thing:
 *
 *   - The sibling has never been tagged at all. Nothing can depend on it, so
 *     this is an error naming the tag that has to be cut.
 *   - The sibling HAS been tagged, and has changed since, but is outside this
 *     release's scope. The release is still correct: it will depend on the last
 *     tagged version. That is worth saying, so it is a warning, and the warning
 *     states only what is verifiable.
 *
 * @param validation - The validated repository.
 * @param releases - The releases this run would publish.
 * @param states - What each recipe looked like when the plan was made.
 */
function checkSiblings(
  validation: RepoValidation,
  releases: PlannedRelease[],
  states: RecipeState[]
): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const releasing = new Map(releases.map((entry) => [entry.key, entry]));
  const byKey = new Map(states.map((state) => [state.key, state]));

  for (const release of releases) {
    for (const siblingKey of siblingKeysOf(validation, release.key)) {
      if (releasing.has(siblingKey)) continue;

      const sibling = byKey.get(siblingKey);
      const where = relativeTo(validation.rootDir, release.manifestPath);

      if (sibling === undefined) {
        problems.push({
          level: "error",
          where,
          message:
            `it depends on '${siblingKey}', which this repository does not publish. A ` +
            `dependency written without a location names a recipe in this same ` +
            `repository.`,
        });
        continue;
      }

      if (sibling.lastTagged === undefined) {
        problems.push({
          level: "error",
          where,
          message:
            `it depends on '${siblingKey}', which has never been published: this ` +
            `repository carries no tag for it. Release it first, which cuts the tag ` +
            `'${tagOf(siblingKey, sibling.version)}'.`,
        });
        continue;
      }

      if (sibling.changed) {
        problems.push({
          level: "warning",
          where,
          message:
            `'${siblingKey}' has changes since '${sibling.lastTag}' that are outside ` +
            `this release's scope; '${release.tag}' will depend on ` +
            `'${sibling.lastTag}'.`,
        });
      }
    }
  }

  return problems;
}

/**
 * Reads the three facts a plan is made of for one recipe: whether the scope
 * covers it, what tag last published it, and whether its files have changed
 * since that tag.
 *
 * @param rootDir - The repository's root directory.
 * @param recipe - The validated recipe.
 * @param scope - The run's scope.
 * @param tags - Every release tag the repository carries.
 * @param run - The command runner git calls go through.
 */
async function readRecipeState(
  rootDir: string,
  recipe: ValidatedRecipe,
  scope: ReleaseScope,
  tags: ReadonlyArray<RecipeTag>,
  run: RunOptions["run"]
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
    ...(highest === undefined ? {} : { lastTagged: highest, lastTag: tagOf(key, highest) }),
  };

  if (highest === undefined) return state;

  // "Changed" is a content question, so it is answered by hashing, exactly the
  // way a consumer decides whether a cached copy is still the published one.
  const workingHash = await hashDirectory(recipe.dir);
  const taggedHash = await withTaggedTree(
    rootDir,
    tagOf(key, highest),
    recipe.path,
    (dir) => hashDirectory(dir),
    { run }
  );
  state.changed = workingHash !== taggedHash;
  return state;
}

/** True when a run's scope covers a recipe. */
function coveredByScope(recipe: ValidatedRecipe, scope: ReleaseScope): boolean {
  if (scopeIsWholeRepository(scope)) return true;
  if (scope.namespaces.includes(recipe.manifest.namespace)) return true;
  return scope.recipes.includes(recipe.key);
}

/** The tag that publishes one version of one recipe key. */
function tagOf(key: string, version: string): string {
  const slash = key.indexOf("/");
  return tagFor(key.slice(0, slash), key.slice(slash + 1), version);
}

/** Renders an absolute path as a repository-relative one, with forward slashes. */
function relativeTo(rootDir: string, target: string): string {
  return path.relative(rootDir, target).split(path.sep).join("/");
}
