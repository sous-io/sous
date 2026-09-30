/**
 * Regenerating a repository's `sous.index.json` from what it actually publishes.
 *
 * The index is the portable contract every provider hands back, so it must
 * describe published reality and nothing else. Three rules follow from that,
 * and this module exists to keep them:
 *
 * 1. A published version is IMMUTABLE. An entry that is already in the index
 *    and carries a tag keeps the hash and the dependencies it was published
 *    with; a recomputed hash that disagrees, or dependencies that no longer
 *    agree with what the version's manifest declares, are reported as errors,
 *    never quietly written over.
 * 2. A version is published when a tag carries it, and every version the index
 *    records has to have one. The single exception is the version a recipe's
 *    manifest declares right now: a release regenerates the index, commits it
 *    alongside the manifests, and tags that commit, so for the length of that
 *    one commit the index describes a version whose tag is about to exist. Any
 *    OLDER version without a tag is an error, because that is a published
 *    version nothing can fetch.
 * 3. The tags are the backstop. A version that has a tag but is missing from the
 *    index is rebuilt from the tagged tree, dependencies included, so deleting
 *    the index file and regenerating it restores the same catalog.
 *
 * Each version entry also records what it was released against, so a consumer
 * installs the versions a recipe was published with rather than re-resolving
 * its ranges long afterwards. Those dependencies are resolved exactly once: when
 * the version is first recorded, against the repository as it stands then (or,
 * for a version rebuilt from its tag, as it stood at that tag), and never again.
 */

import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import { INDEX_FILENAME } from "../formats/common.js";
import {
  parseIndexFile,
  stringifyIndexFile,
  type IndexDependency,
  type IndexFile,
  type IndexRecipe,
  type IndexVersion,
} from "../formats/index-file.js";
import { parseRecipeManifest } from "../formats/recipe-manifest.js";
import { loadJsonFile, parseYamlText, parseJsoncText } from "../load-manifest.js";
import { hashDirectory } from "../store/hash.js";
import type { RunOptions } from "../providers/git.js";
import {
  listRecipeTags,
  readFileAtTag,
  recipeTagKey,
  tagCommitDate,
  tagFor,
  withTaggedTree,
  type RecipeTag,
} from "./tags.js";
import {
  describeError,
  validateRepo,
  type RepoValidation,
  type ValidatedRecipe,
  type ValidationProblem,
} from "./validate.js";
import { isNamedReading, parseRef, refKey } from "../../refs/parse.js";
import { RefSource } from "../../refs/scopes.js";
import type { SettledDependency } from "./settle.js";

/** A version that is ready to publish but has no tag yet. */
export type PendingRelease = {
  /** The recipe's key, `namespace/recipe`. */
  key: string;
  /** The recipe folder, relative to the repository root. */
  path: string;
  /** The version its manifest declares. */
  version: string;
  /** The tag that would carry it. */
  tag: string;
  /** The content hash of the recipe folder as it stands in the working tree. */
  hash: string;
};

/** What one regeneration produced. */
export type IndexBuildResult = {
  /** The regenerated index, ready to be written. */
  index: IndexFile;
  /** The index exactly as it would be written, so a caller can compare or save it. */
  text: string;
  /** True when the committed index differs from the regenerated one. */
  stale: boolean;
  /** Versions with no tag yet, in the order the repo manifest lists their recipes. */
  pending: PendingRelease[];
  /** Everything the regeneration found wrong, errors and warnings together. */
  problems: ValidationProblem[];
  /** Every recipe release tag the repository carries. */
  tags: RecipeTag[];
};

/** What `buildIndex` needs to know. */
export type BuildIndexOptions = {
  /** The validated repository, from `validateRepo`. */
  validation: RepoValidation;
  /** The committed index, when there is a readable one. */
  existing?: IndexFile;
  /** The version of sous doing the regeneration, recorded as the generator. */
  sousVersion: string;
  /** When the regeneration ran. Defaults to now. */
  now?: Date;
  /** Every release tag, when the caller has already listed them. */
  tags?: RecipeTag[];
  /** The command runner git calls go through. */
  run?: RunOptions["run"];
  /**
   * The versions this run is about to publish, keyed `namespace/recipe`. Their
   * tags do not exist yet: the index is regenerated, committed alongside the
   * manifests, and only then tagged, so the tagged commit already carries an
   * index that describes itself.
   */
  publishing?: Record<string, string>;
  /**
   * The dependencies that read more than one way, as `settleDependencyLocations`
   * settled them, keyed by the dependency as written. Each is recorded under
   * the keys it reached, with the repository it settled on.
   */
  settled?: Map<string, SettledDependency>;
};

/** The index file's absolute path in a repository. */
export function indexFilePath(rootDir: string): string {
  return path.join(rootDir, INDEX_FILENAME);
}

/**
 * Reads and validates the committed index, or returns undefined when there is
 * none. A file that is present but unreadable raises a ConfigError; the caller
 * decides whether to fail or to regenerate from the tags instead.
 *
 * @param rootDir - The repository's root directory.
 */
export function readIndexFile(rootDir: string): IndexFile | undefined {
  const filePath = indexFilePath(rootDir);
  if (!fs.existsSync(filePath)) return undefined;
  return parseIndexFile(loadJsonFile(filePath, "repository index"), filePath);
}

/**
 * Regenerates a repository's index from its recipe manifests and its tags.
 *
 * @param options - The validated repository and everything the regeneration needs.
 */
export async function buildIndex(
  options: BuildIndexOptions
): Promise<IndexBuildResult> {
  const { validation, existing, sousVersion } = options;
  const rootDir = validation.rootDir;
  const now = options.now ?? new Date();
  const run = options.run;

  const tags = options.tags ?? (await listRecipeTags(rootDir, { run }));
  const tagsByKey = groupTagsByKey(tags);
  const problems: ValidationProblem[] = [];
  const pending: PendingRelease[] = [];

  const namespaces: IndexFile["namespaces"] = {};
  for (const [name, declaration] of Object.entries(validation.manifest.namespaces)) {
    namespaces[name] =
      declaration.description === undefined
        ? {}
        : { description: declaration.description };
  }

  const recipes: IndexFile["recipes"] = {};

  // What each recipe in this repository is published at once this run is done,
  // and every version each of them publishes. Both are needed to turn a
  // dependency's declared range into the exact version a consumer installs.
  const publishing = options.publishing ?? {};
  const current = siblingState(validation, tagsByKey, existing, publishing);

  for (const recipe of validation.recipes) {
    if (!Object.hasOwn(namespaces, recipe.manifest.namespace)) continue;

    const key = recipe.key;
    const existingVersions = existing?.recipes[key]?.versions ?? {};
    const versions: Record<string, IndexVersion> = { ...existingVersions };
    const recipeTags = tagsByKey.get(key) ?? [];
    const manifestName = path.basename(recipe.manifestPath);

    // Rule 3: every tagged version belongs in the index, including ones the
    // committed index has lost. Its dependencies are resolved against the
    // repository as it stood at the tag, which is what it was released against.
    for (const tag of recipeTags) {
      if (Object.hasOwn(versions, tag.version)) continue;
      const rebuilt = await rebuildTaggedVersion(
        rootDir,
        tag,
        recipe,
        tagsByKey,
        existing,
        run,
        options.settled
      );
      problems.push(...rebuilt.problems);
      versions[tag.version] = {
        hash: rebuilt.hash,
        tag: tag.tag,
        prerelease: semver.prerelease(tag.version) !== null,
        ...(await releasedAtOf(rootDir, tag.tag, run)),
        ...(rebuilt.dependencies === undefined ? {} : { dependencies: rebuilt.dependencies }),
      };
    }

    const version = recipe.manifest.version;
    const tagName = tagFor(recipe.manifest.namespace, recipe.manifest.name, version);
    const hasTag = recipeTags.some((entry) => entry.tag === tagName);
    const workingHash = await hashDirectory(recipe.dir);
    const where = relativeTo(rootDir, recipe.manifestPath);
    const declared = declaredDependencies(recipe, validation, options.settled);

    // A version the index publishes must have a tag, with one exception: the
    // version the manifest declares right now, which is the one a release is in
    // the middle of publishing. Everything older is history, and history with a
    // missing tag is a published version nothing can fetch.
    for (const [known, published] of Object.entries(existingVersions)) {
      if (known === version) continue;
      if (recipeTags.some((entry) => entry.version === known)) continue;
      problems.push({
        level: "error",
        where: `${INDEX_FILENAME} recipes['${key}'].versions['${known}']`,
        message:
          `the index publishes version ${known}, but the tag '${published.tag}' does not ` +
          `exist in this repository. A missing tag must never hide a published version; ` +
          `restore the tag, or remove the version from the index.`,
      });
    }

    if (hasTag) {
      problems.push(
        ...(await checkTaggedMetadata(rootDir, tagName, recipe.path, manifestName, version, where, run))
      );

      const taggedHash = await hashTaggedRecipe(rootDir, tagName, recipe.path, run);
      const published = existingVersions[version];

      if (published !== undefined && published.hash !== taggedHash) {
        problems.push({
          level: "error",
          where: `${INDEX_FILENAME} recipes['${key}'].versions['${version}']`,
          message:
            `the index records a different content hash from the one the tag '${tagName}' ` +
            `now carries. A published version never changes, so either the tag was moved ` +
            `or the index was edited; restore whichever is wrong before releasing again.`,
        });
      } else if (published !== undefined) {
        // Already published: the entry is carried forward as it stands, its
        // dependencies and any field a later sous wrote included. Only a missing
        // release date is filled in, from the tag.
        if (published.releasedAt === undefined) {
          versions[version] = { ...published, ...(await releasedAtOf(rootDir, tagName, run)) };
        }
        // The check needs the manifest that was published, which the working one
        // is only while the folder still matches the tag. An entry with no
        // dependencies at all was published before sous recorded them; a
        // consumer resolves that version's ranges, and it stays that way.
        if (taggedHash === workingHash && published.dependencies !== undefined) {
          problems.push(
            ...checkRecordedDependencies(key, version, published.dependencies, declared)
          );
        }
      }
      // A tagged version the index did not record was rebuilt from its tag above.

      if (taggedHash !== workingHash) {
        // A recipe this run is not publishing is allowed to have unpublished
        // changes sitting in it: that is what a scoped release leaves behind,
        // and it is worth saying rather than stopping for.
        const publishingThis =
          options.publishing === undefined || Object.hasOwn(publishing, key);
        problems.push({
          level: publishingThis ? "error" : "warning",
          where,
          message: publishingThis
            ? `version ${version} was already published as the tag '${tagName}', and the ` +
              `files in this folder no longer match what that tag carries. A published ` +
              `version never changes: bump the version in this manifest, or with ` +
              `'sous repo release --bump patch'.`
            : `version ${version} is published as the tag '${tagName}', and this folder has ` +
              `changed since. Those changes are outside this release, so they stay ` +
              `unpublished; release '${key}' to publish them.`,
        });
      }
    } else {
      // No tag yet. The version is either one this run is about to cut, or one
      // a release commit already recorded and CI will cut after the merge; in
      // both cases the index describes it from the working tree, and the tag
      // follows on the very commit that carries this index.
      const published = existingVersions[version];
      if (options.publishing?.[key] === version || published !== undefined) {
        const dependencies = resolveIndexDependencies(declared, current);
        versions[version] = {
          hash: workingHash,
          tag: tagName,
          prerelease: semver.prerelease(version) !== null,
          releasedAt: published?.releasedAt ?? now.toISOString(),
          ...(dependencies === undefined ? {} : { dependencies }),
        };
      }

      pending.push({
        key,
        path: recipe.path,
        version,
        tag: tagName,
        hash: workingHash,
      });
    }

    if (Object.keys(versions).length > 0) {
      const entry: IndexRecipe = { path: recipe.path, versions };
      if (recipe.manifest.description !== undefined) {
        entry.description = recipe.manifest.description;
      }
      recipes[key] = entry;
    }
  }

  problems.push(...checkOrphanTags(validation, tags));

  const index: IndexFile = {
    formatVersion: 1,
    name: validation.manifest.name,
    generatedAt: now.toISOString(),
    generator: sousVersion,
    namespaces,
    recipes,
  };

  // The stamp changes on every run, so it is only allowed to change the file
  // when something else did too; otherwise `--check` would call a perfectly
  // current index stale every time it ran.
  if (existing !== undefined && sameExceptStamp(existing, index)) {
    index.generatedAt = existing.generatedAt;
  }

  const text = stringifyIndexFile(index);
  const stale = existing === undefined || stringifyIndexFile(existing) !== text;

  return { index, text, stale, pending, problems, tags };
}

/**
 * Says, in plain language, how a committed index differs from a regenerated
 * one. This is what `--check` prints when it refuses: an author needs to know
 * which recipe and which version is out of step, not that two files differ.
 *
 * @param existing - The committed index, or undefined when there is none.
 * @param rebuilt - The regenerated index.
 */
export function describeIndexDrift(
  existing: IndexFile | undefined,
  rebuilt: IndexFile
): string[] {
  if (existing === undefined) {
    return [`there is no ${INDEX_FILENAME} in this repository yet`];
  }

  const lines: string[] = [];

  if (existing.name !== rebuilt.name) {
    lines.push(
      `the index calls this repository '${existing.name}', and its manifest calls it ` +
        `'${rebuilt.name}'`
    );
  }
  if (existing.generator !== rebuilt.generator) {
    lines.push(
      `the index was generated by sous ${existing.generator}, and this is sous ` +
        `${rebuilt.generator}`
    );
  }

  for (const name of Object.keys(rebuilt.namespaces)) {
    if (!Object.hasOwn(existing.namespaces, name)) {
      lines.push(`the namespace '${name}' is missing from the index`);
    }
  }
  for (const name of Object.keys(existing.namespaces)) {
    if (!Object.hasOwn(rebuilt.namespaces, name)) {
      lines.push(`the index still declares the namespace '${name}'`);
    }
  }

  for (const [key, recipe] of Object.entries(rebuilt.recipes)) {
    const before = existing.recipes[key];
    if (before === undefined) {
      lines.push(`the recipe '${key}' is missing from the index`);
      continue;
    }
    if (before.path !== recipe.path) {
      lines.push(
        `the recipe '${key}' is listed at '${before.path}' in the index and at ` +
          `'${recipe.path}' in the repository`
      );
    }
    if (before.description !== recipe.description) {
      lines.push(`the description of '${key}' has changed since the index was written`);
    }
    for (const version of Object.keys(recipe.versions)) {
      if (!Object.hasOwn(before.versions, version)) {
        lines.push(`version ${version} of '${key}' is missing from the index`);
      }
    }
  }

  for (const [key, recipe] of Object.entries(existing.recipes)) {
    if (!Object.hasOwn(rebuilt.recipes, key)) {
      lines.push(`the index still publishes '${key}', which this repository does not`);
      continue;
    }
    for (const version of Object.keys(recipe.versions)) {
      if (!Object.hasOwn(rebuilt.recipes[key]!.versions, version)) {
        lines.push(`the index still publishes version ${version} of '${key}'`);
      }
    }
  }

  if (lines.length === 0) {
    lines.push("the index differs from what this repository describes");
  }
  return lines;
}

// --- Internals ----------------------------------------------------------------------------------

/**
 * One dependency a recipe's manifest declares, keyed `namespace/recipe` in
 * `DeclaredDependencies`. A whole-namespace declaration is expanded into one
 * entry per recipe the namespace holds.
 */
type DeclaredDependency =
  | {
      /** A recipe in another repository, named by its location. */
      kind: "remote";
      /** The canonical identity of the repository publishing it. */
      repo: string;
      /** The range the manifest declared, `*` when it declared none. */
      range: string;
    }
  | {
      /** A recipe in this same repository. */
      kind: "sibling";
      /** The range the manifest declared, when it declared one. */
      range?: string;
      /**
       * True when the manifest names this recipe itself, rather than only the
       * namespace holding it. A recipe a namespace gained after a version was
       * published is rightly missing from that version's entry; one the
       * manifest names is not.
       */
      named: boolean;
    };

/** Everything one recipe's manifest declares, under `depends` and `subscribes`. */
type DeclaredDependencies = {
  /** Every dependency, keyed `namespace/recipe`; a later declaration wins over an earlier one. */
  byKey: Map<string, DeclaredDependency>;
  /** The namespaces of this repository the manifest declares whole. */
  namespaces: Set<string>;
};

/** What each recipe of a repository is published at, as one resolution sees it. */
type SiblingState = {
  /** The version each recipe is released at, which is what "released alongside me" means. */
  settled: Map<string, string>;
  /** Every version each recipe publishes, for resolving a declared range. */
  published: Map<string, string[]>;
};

/**
 * Reads the dependencies a recipe's manifest declares, expanding a
 * whole-namespace declaration into the recipes that namespace holds.
 *
 * @param recipe - The recipe whose dependencies are being read.
 * @param validation - The validated repository, for expanding namespace refs.
 * @param settled - The dependencies that read more than one way, as the release settled them.
 */
function declaredDependencies(
  recipe: ValidatedRecipe,
  validation: RepoValidation,
  settled: Map<string, SettledDependency> = new Map()
): DeclaredDependencies {
  const byKey = new Map<string, DeclaredDependency>();
  const namespaces = new Set<string>();
  const declared = [
    ...(recipe.manifest.depends ?? []),
    ...(recipe.manifest.subscribes ?? []),
  ];

  /** Records one sibling, remembering whether any declaration named it. */
  const addSibling = (key: string, range: string | undefined, named: boolean): void => {
    const before = byKey.get(key);
    const namedBefore = before?.kind === "sibling" && before.named;
    byKey.set(key, {
      kind: "sibling",
      ...(range === undefined ? {} : { range }),
      named: named || namedBefore,
    });
  };

  for (const written of declared) {
    // A dependency that reads more than one way was settled by the release,
    // and what it settled on is what a consumer reads instead of probing.
    const answer = settled.get(written.trim());
    if (answer !== undefined) {
      for (const key of answer.keys) {
        byKey.set(key, { kind: "remote", repo: answer.identity, range: answer.range ?? "*" });
      }
      continue;
    }

    let readings;
    try {
      readings = parseRef(written, RefSource.Manifest);
    } catch {
      // A dependency that does not parse is already reported by validation.
      continue;
    }
    // Several readings, or a browser path, are settled above or reported by
    // the settling step; there is nothing more to record here.
    const parsed = readings[0]!;
    if (readings.length !== 1 || !isNamedReading(parsed)) continue;

    if (parsed.location !== undefined) {
      // A whole namespace in another repository is read from that repository's
      // own index by the consumer; only a recipe has a key to record.
      if (parsed.recipe !== undefined) {
        byKey.set(refKey(parsed), {
          kind: "remote",
          repo: parsed.location.identity,
          range: parsed.range ?? "*",
        });
      }
      continue;
    }

    if (parsed.recipe !== undefined) {
      addSibling(refKey(parsed), parsed.range, true);
      continue;
    }

    // A whole-namespace dependency means every recipe in that namespace.
    namespaces.add(parsed.namespace);
    for (const entry of validation.recipes) {
      if (entry.manifest.namespace !== parsed.namespace) continue;
      if (entry.key === recipe.key) continue;
      addSibling(entry.key, undefined, false);
    }
  }

  return { byKey, namespaces };
}

/**
 * Works out what each recipe of a repository is published at, for resolving
 * the dependencies of a version being recorded.
 *
 * Two moments call this. A run recording a NEW version resolves against the
 * repository as it stands, counting the versions the run itself is publishing.
 * A run rebuilding a version from its TAG resolves against the repository as
 * it stood at that tag (no `publishing` given): a sibling is settled on the
 * version its manifest declared there, and only versions up to that one count
 * as published.
 *
 * @param validation - The repository, as it stands or as it stood at a tag.
 * @param tagsByKey - Every release tag, grouped by recipe.
 * @param existing - The committed index, when there is one.
 * @param publishing - The versions this run publishes; omitted for a tag.
 */
function siblingState(
  validation: RepoValidation,
  tagsByKey: Map<string, RecipeTag[]>,
  existing: IndexFile | undefined,
  publishing?: Record<string, string>
): SiblingState {
  const settled = new Map<string, string>();
  const published = new Map<string, string[]>();

  for (const recipe of validation.recipes) {
    const version = publishing?.[recipe.key] ?? recipe.manifest.version;
    settled.set(recipe.key, version);

    const known = new Set((tagsByKey.get(recipe.key) ?? []).map((tag) => tag.version));
    for (const other of Object.keys(existing?.recipes[recipe.key]?.versions ?? {})) {
      known.add(other);
    }
    known.add(version);

    const all = [...known];
    published.set(
      recipe.key,
      publishing === undefined ? all.filter((other) => semver.lte(other, version)) : all
    );
  }

  return { settled, published };
}

/**
 * Turns one recipe's declared dependencies into the exact versions its index
 * entry publishes.
 *
 * This is the whole point of recording dependencies in the index: a consumer
 * installing version 1.4.0 of a recipe installs what 1.4.0 was released
 * against, not whatever its ranges happen to reach months later. That is also
 * why this runs only when a version is first recorded; an entry the index
 * already publishes is carried forward and never resolved again.
 *
 *   - A SIBLING with no range means "the version released alongside me", which
 *     is the version that sibling is settled on.
 *   - A SIBLING with a range resolves against the versions this repository
 *     publishes.
 *   - A CROSS-REPOSITORY dependency carries the identity of the repository it
 *     lives in, which is what a consumer needs in order to add that repository
 *     and find the recipe. Its exact version belongs to that repository's own
 *     index, so the range the manifest declared is recorded instead.
 *
 * @param declared - What the recipe's manifest declares.
 * @param siblings - What each recipe here is published at, for this resolution.
 */
function resolveIndexDependencies(
  declared: DeclaredDependencies,
  siblings: SiblingState
): Record<string, IndexDependency> | undefined {
  const resolved: Record<string, IndexDependency> = {};

  for (const [key, dependency] of declared.byKey) {
    if (dependency.kind === "remote") {
      resolved[key] = { repo: dependency.repo, range: dependency.range };
      continue;
    }
    if (dependency.range === undefined) {
      const settled = siblings.settled.get(key);
      resolved[key] = settled === undefined ? { range: "*" } : { version: settled };
      continue;
    }
    const best = semver.maxSatisfying(siblings.published.get(key) ?? [], dependency.range);
    resolved[key] = best === null ? { range: dependency.range } : { version: best };
  }

  return Object.keys(resolved).length === 0 ? undefined : resolved;
}

/**
 * Checks the dependencies the index records for an already published version
 * against what that version's manifest declares.
 *
 * The recorded list is frozen, so it is never compared with a fresh
 * resolution: a sibling released since, or a recipe a declared namespace has
 * gained since, is exactly what freezing keeps out of it. What must still hold
 * is that the list honours the manifest: every recipe the manifest names is
 * there, nothing is there that the manifest does not declare, a sibling sits
 * inside its declared range, and a dependency in another repository carries the
 * repository and range the manifest wrote. A disagreement means the index was
 * edited, or this sous reads the manifest differently from the one that
 * published the version.
 *
 * @param key - The recipe's key, `namespace/recipe`.
 * @param version - The published version.
 * @param recorded - The dependencies the index records for it.
 * @param declared - What the version's manifest declares.
 */
function checkRecordedDependencies(
  key: string,
  version: string,
  recorded: Record<string, IndexDependency> | undefined,
  declared: DeclaredDependencies
): ValidationProblem[] {
  const differences: string[] = [];
  const entries = recorded ?? {};

  for (const [name, dependency] of declared.byKey) {
    const entry = entries[name];
    if (entry === undefined) {
      if (dependency.kind === "remote" || dependency.named) {
        differences.push(
          `'${name}': the manifest declares ${describeDeclared(dependency)}, and the index ` +
            `records nothing for it`
        );
      }
      continue;
    }
    if (!recordedSatisfies(entry, dependency)) {
      differences.push(
        `'${name}': the index records ${describeRecorded(entry)}, and the manifest declares ` +
          `${describeDeclared(dependency)}`
      );
    }
  }

  for (const [name, entry] of Object.entries(entries)) {
    if (declared.byKey.has(name)) continue;
    // A recipe the declared namespace held when the version was published, and
    // no longer does, is history rather than a disagreement.
    const namespace = name.slice(0, name.indexOf("/"));
    if (entry.repo === undefined && declared.namespaces.has(namespace)) continue;
    differences.push(
      `'${name}': the index records ${describeRecorded(entry)}, and the manifest does not ` +
        `declare it`
    );
  }

  if (differences.length === 0) return [];
  return [
    {
      level: "error",
      where: `${INDEX_FILENAME} recipes['${key}'].versions['${version}'].dependencies`,
      message:
        `version ${version} of '${key}' is already published, and the dependencies the index ` +
        `records for it disagree with what its manifest declares:\n` +
        differences.map((line) => `    - ${line}\n`).join("") +
        `  A published version never changes, so a release carries its dependencies forward ` +
        `exactly as they were published. If the index was edited, restore the entry. To ` +
        `publish different dependencies, bump the version in this manifest, or with ` +
        `'sous repo release --bump patch'.`,
    },
  ];
}

/** True when a recorded dependency honours what the manifest declares for it. */
function recordedSatisfies(entry: IndexDependency, dependency: DeclaredDependency): boolean {
  if (dependency.kind === "remote") {
    return (
      entry.repo === dependency.repo &&
      entry.range === dependency.range &&
      entry.version === undefined
    );
  }
  if (entry.repo !== undefined) return false;
  if (dependency.range === undefined) return true;
  if (entry.version !== undefined) return semver.satisfies(entry.version, dependency.range);
  return entry.range === dependency.range;
}

/** Describes a recorded dependency the way an author would say it. */
function describeRecorded(entry: IndexDependency): string {
  const what =
    entry.version !== undefined ? `version ${entry.version}` : `the range '${entry.range}'`;
  return entry.repo === undefined ? what : `${what} from ${entry.repo}`;
}

/** Describes a declared dependency the way an author would say it. */
function describeDeclared(dependency: DeclaredDependency): string {
  if (dependency.kind === "remote") {
    return `the range '${dependency.range}' from ${dependency.repo}`;
  }
  return dependency.range === undefined ? "it with no range" : `the range '${dependency.range}'`;
}

/** What rebuilding one tagged version from its tag produced. */
type RebuiltVersion = {
  /** The content hash of the recipe folder at the tag. */
  hash: string;
  /** The dependencies it was released against, when they could be worked out. */
  dependencies?: Record<string, IndexDependency>;
  /** A warning when they could not. */
  problems: ValidationProblem[];
};

/**
 * Rebuilds a tagged version the index does not record, from the tree its tag
 * carries: the content hash of the recipe folder, and the dependencies its
 * manifest declared there, resolved against the repository as it stood at the
 * tag. That is as close as sous can get to what the release that cut the tag
 * recorded; it is resolved once, then frozen like any other entry.
 *
 * @param rootDir - The repository's root directory.
 * @param tag - The tag to rebuild from.
 * @param recipe - The recipe as it stands now, for its folder and its key.
 * @param tagsByKey - Every release tag, grouped by recipe.
 * @param existing - The committed index, when there is one.
 * @param run - The command runner git calls go through.
 * @param settled - The dependencies that read more than one way, as the release settled them.
 */
async function rebuildTaggedVersion(
  rootDir: string,
  tag: RecipeTag,
  recipe: ValidatedRecipe,
  tagsByKey: Map<string, RecipeTag[]>,
  existing: IndexFile | undefined,
  run: RunOptions["run"],
  settled?: Map<string, SettledDependency>
): Promise<RebuiltVersion> {
  return withTaggedTree(
    rootDir,
    tag.tag,
    ".",
    async (treeDir) => {
      const hash = await hashDirectory(path.join(treeDir, ...recipe.path.split("/")));

      let reason: string;
      try {
        const snapshot = validateRepo(treeDir);
        const tagged = snapshot.recipes.find((entry) => entry.key === recipe.key);
        if (tagged !== undefined) {
          const dependencies = resolveIndexDependencies(
            declaredDependencies(tagged, snapshot, settled),
            siblingState(snapshot, tagsByKey, existing)
          );
          return { hash, ...(dependencies === undefined ? {} : { dependencies }), problems: [] };
        }
        reason = `The repository manifest at that tag does not list '${recipe.key}'.`;
      } catch (error) {
        reason = describeError(error);
      }

      return {
        hash,
        problems: [
          {
            level: "warning",
            where: `${INDEX_FILENAME} recipes['${recipe.key}'].versions['${tag.version}']`,
            message:
              `version ${tag.version} was rebuilt from the tag '${tag.tag}' without its ` +
              `dependencies, because sous could not read the recipe at that tag.\n  ${reason}`,
          },
        ],
      };
    },
    { run }
  );
}

/** Groups release tags by the recipe key they belong to. */
function groupTagsByKey(tags: ReadonlyArray<RecipeTag>): Map<string, RecipeTag[]> {
  const grouped = new Map<string, RecipeTag[]>();
  for (const tag of tags) {
    const key = recipeTagKey(tag);
    const list = grouped.get(key);
    if (list === undefined) grouped.set(key, [tag]);
    else list.push(tag);
  }
  return grouped;
}

/** The content hash of a recipe folder as it stood at a tag. */
async function hashTaggedRecipe(
  rootDir: string,
  tag: string,
  recipePath: string,
  run: RunOptions["run"]
): Promise<string> {
  return withTaggedTree(rootDir, tag, recipePath, (dir) => hashDirectory(dir), { run });
}

/** The `releasedAt` field for a tag, or nothing when git cannot date it. */
async function releasedAtOf(
  rootDir: string,
  tag: string,
  run: RunOptions["run"]
): Promise<{ releasedAt?: string }> {
  const date = await tagCommitDate(rootDir, tag, { run });
  return date === undefined ? {} : { releasedAt: date };
}

/**
 * Confirms the recipe manifest carried by a tag declares the version the tag
 * names. A tag whose metadata says something else is the exact failure the
 * design forbids: a version hidden behind a tag that disagrees with it.
 */
async function checkTaggedMetadata(
  rootDir: string,
  tag: string,
  recipePath: string,
  manifestName: string,
  version: string,
  where: string,
  run: RunOptions["run"]
): Promise<ValidationProblem[]> {
  const text = await readFileAtTag(rootDir, tag, `${recipePath}/${manifestName}`, { run });
  if (text === undefined) {
    return [
      {
        level: "error",
        where,
        message:
          `the tag '${tag}' does not carry a '${manifestName}' at '${recipePath}'. The tag ` +
          `and the recipe metadata must agree about what was published.`,
      },
    ];
  }

  let taggedVersion: string | undefined;
  try {
    const raw = manifestName.endsWith(".json")
      ? parseJsoncText(text, `${tag}:${recipePath}/${manifestName}`)
      : parseYamlText(text, `${tag}:${recipePath}/${manifestName}`);
    taggedVersion = parseRecipeManifest(raw, `${tag}:${recipePath}/${manifestName}`).version;
  } catch (error) {
    return [
      {
        level: "warning",
        where,
        message:
          `the recipe manifest at the tag '${tag}' could not be read, so sous cannot confirm ` +
          `the tag and the metadata agree.\n  ${describeError(error)}`,
      },
    ];
  }

  if (taggedVersion !== version) {
    return [
      {
        level: "error",
        where,
        message:
          `the tag '${tag}' carries a manifest declaring version ${taggedVersion}, not ` +
          `${version}. Recipe metadata is the source of truth for versions, so the tag is ` +
          `wrong; delete it and let 'sous repo release' cut it again.`,
      },
    ];
  }

  return [];
}

/**
 * Reports release tags that belong to no recipe this repository publishes any
 * more. That is ordinary history after a recipe is renamed or retired, so it is
 * a warning: it is worth saying, and it is not worth stopping for.
 */
function checkOrphanTags(
  validation: RepoValidation,
  tags: ReadonlyArray<RecipeTag>
): ValidationProblem[] {
  const known = new Set(validation.recipes.map((recipe) => recipe.key));
  const orphaned = new Map<string, string[]>();

  for (const tag of tags) {
    const key = recipeTagKey(tag);
    if (known.has(key)) continue;
    const list = orphaned.get(key);
    if (list === undefined) orphaned.set(key, [tag.tag]);
    else list.push(tag.tag);
  }

  return [...orphaned.entries()].map(([key, tagNames]) => ({
    level: "warning" as const,
    where: `tags for '${key}'`,
    message:
      `this repository carries ${tagNames.length} release ${
        tagNames.length === 1 ? "tag" : "tags"
      } for '${key}' (${tagNames.join(", ")}), which it no longer publishes. That is normal ` +
      `after a recipe is renamed or retired; the tags are left alone.`,
  }));
}

/** True when two indexes differ only in when they were generated. */
function sameExceptStamp(left: IndexFile, right: IndexFile): boolean {
  const strip = (index: IndexFile) => stringifyIndexFile({ ...index, generatedAt: "" });
  return strip(left) === strip(right);
}

/** Renders an absolute path as a repository-relative one, with forward slashes. */
function relativeTo(rootDir: string, target: string): string {
  return path.relative(rootDir, target).split(path.sep).join("/");
}
