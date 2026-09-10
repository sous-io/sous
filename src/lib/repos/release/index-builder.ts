/**
 * Regenerating a repository's `sous.index.json` from what it actually publishes.
 *
 * The index is the portable contract every provider hands back, so it must
 * describe published reality and nothing else. Three rules follow from that,
 * and this module exists to keep them:
 *
 * 1. A published version is IMMUTABLE. An entry that is already in the index
 *    keeps the hash it was published with; a recomputed hash that disagrees is
 *    reported as an error, never quietly written over.
 * 2. A version is published when a tag carries it. The index schema requires a
 *    tag on every version entry, so a version whose tag has not been cut yet is
 *    left OUT of the index and reported as pending instead.
 * 3. The tags are the backstop. A version that has a tag but is missing from the
 *    index is rebuilt from the tagged tree, so deleting the index file and
 *    regenerating it restores the same catalog.
 */

import fs from "node:fs";
import path from "node:path";
import semver from "semver";
import { INDEX_FILENAME } from "../formats/common.js";
import {
  parseIndexFile,
  stringifyIndexFile,
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
import { describeError, type RepoValidation, type ValidationProblem } from "./validate.js";

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

  for (const recipe of validation.recipes) {
    if (!Object.hasOwn(namespaces, recipe.manifest.namespace)) continue;

    const key = recipe.key;
    const existingVersions = existing?.recipes[key]?.versions ?? {};
    const versions: Record<string, IndexVersion> = { ...existingVersions };
    const recipeTags = tagsByKey.get(key) ?? [];
    const manifestName = path.basename(recipe.manifestPath);

    // Rule 3: every tagged version belongs in the index, including ones the
    // committed index has lost.
    for (const tag of recipeTags) {
      if (Object.hasOwn(versions, tag.version)) continue;
      versions[tag.version] = {
        hash: await hashTaggedRecipe(rootDir, tag.tag, recipe.path, run),
        tag: tag.tag,
        prerelease: semver.prerelease(tag.version) !== null,
        ...(await releasedAtOf(rootDir, tag.tag, run)),
      };
    }

    const version = recipe.manifest.version;
    const tagName = tagFor(recipe.manifest.namespace, recipe.manifest.name, version);
    const hasTag = recipeTags.some((entry) => entry.tag === tagName);
    const workingHash = await hashDirectory(recipe.dir);
    const where = relativeTo(rootDir, recipe.manifestPath);

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
      } else {
        versions[version] = {
          hash: taggedHash,
          tag: tagName,
          prerelease: semver.prerelease(version) !== null,
          ...(await releasedAtOf(rootDir, tagName, run)),
        };
      }

      if (taggedHash !== workingHash) {
        problems.push({
          level: "error",
          where,
          message:
            `version ${version} was already published as the tag '${tagName}', and the files ` +
            `in this folder no longer match what that tag carries. A published version never ` +
            `changes: bump the version in this manifest, or with 'sous repo release --bump patch'.`,
        });
      }
    } else {
      const published = existingVersions[version];
      if (published !== undefined) {
        problems.push({
          level: "error",
          where: `${INDEX_FILENAME} recipes['${key}'].versions['${version}']`,
          message:
            `the index publishes version ${version}, but the tag '${tagName}' does not exist ` +
            `in this repository. A missing tag must never hide a published version; restore ` +
            `the tag, or remove the version from the index.`,
        });
      } else {
        pending.push({
          key,
          path: recipe.path,
          version,
          tag: tagName,
          hash: workingHash,
        });
      }
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
          `wrong; delete it and let 'sous repo release --tag' cut it again.`,
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
