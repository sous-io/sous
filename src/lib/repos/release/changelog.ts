/**
 * The changelog `sous repo submit` writes under a proposal's description.
 *
 * A maintainer reviewing a proposal needs to know what merging it does to the
 * people who subscribe to the repository: which recipes appear, disappear or
 * change version, which will be released as a patch because their files
 * changed without a version raise, which namespaces come and go, and which
 * variables change. None of that is in a commit message, and all of it can be
 * read from the manifests, so sous reads them: the ones the change carries,
 * compared with the ones on the default branch.
 *
 * The changelog explains; it never refuses. Whether a change is acceptable is
 * the repository's own checks' business, so a change that affects subscribers
 * is described here, with a warning where one is due, and never blocked.
 *
 * Reading the default branch's manifests goes through git and the injectable
 * runner; everything after that is pure, so the comparison is tested without a
 * repository at all.
 */

import path from "node:path";
import semver from "semver";
import {
  MANIFEST_EXTENSIONS,
  RECIPE_MANIFEST_BASENAME,
  REPO_MANIFEST_BASENAME,
} from "../formats/common.js";
import {
  parseRecipeManifest,
  recipeManifestKey,
  type RecipeManifest,
  type VariableDefinition,
} from "../formats/recipe-manifest.js";
import { parseRepoManifest, type RepoManifest } from "../formats/repo-manifest.js";
import { parseJsoncText, parseYamlText } from "../load-manifest.js";
import type { RunOptions } from "../providers/git.js";
import { pathsInside } from "./submissions.js";
import { readFileAtTag } from "./tags.js";
import type { RepoValidation } from "./validate.js";

/** The manifests as they stood at one commit. */
export type ManifestSnapshot = {
  /** The repo manifest. */
  repo: RepoManifest;
  /** Every recipe manifest that could be read, keyed by recipe key. */
  recipes: Map<string, { path: string; manifest: RecipeManifest }>;
};

/** One recipe that appeared or disappeared. */
export type RecipeEntry = { key: string; version: string };

/** One recipe whose declared version moved. */
export type VersionChange = { key: string; from: string; to: string };

/** One recipe whose files changed while its version stayed where it was. */
export type UnraisedChange = { key: string; version: string; next: string };

/** One variable that was added, removed or changed. */
export type VariableChange = {
  /** The recipe that declares it. */
  recipe: string;
  /** The variable's name. */
  name: string;
  /** What happened to it. */
  change: "added" | "removed" | "changed";
  /** The fields that changed, for a changed variable. */
  fields?: string[];
  /** True when the change usually breaks a subscriber: a removal, or a tighter rule. */
  breaking: boolean;
};

/** Everything merging a change would do, as the manifests describe it. */
export type Changelog = {
  /** The branch the change was compared with. */
  baseBranch: string;
  /** False when there was nothing to compare with; every list is then empty. */
  compared: boolean;
  namespacesAdded: string[];
  namespacesRemoved: string[];
  recipesAdded: RecipeEntry[];
  recipesRemoved: RecipeEntry[];
  versionChanges: VersionChange[];
  unraised: UnraisedChange[];
  variables: VariableChange[];
};

/**
 * Reads the repo manifest and every recipe manifest it lists as they stood at
 * one commit. Returns undefined when that commit holds no repo manifest sous
 * can read; a recipe manifest it cannot read is left out rather than failing
 * the whole comparison.
 *
 * @param rootDir - The repository's root directory.
 * @param commit - The commit to read at.
 * @param options - The command runner to use.
 */
export async function readManifestsAt(
  rootDir: string,
  commit: string,
  options: RunOptions = {}
): Promise<ManifestSnapshot | undefined> {
  const repoRaw = await readManifestAt(rootDir, commit, "", REPO_MANIFEST_BASENAME, options);
  if (repoRaw === undefined) return undefined;

  let repo: RepoManifest;
  try {
    repo = parseRepoManifest(repoRaw.value, `${repoRaw.file} at ${commit.slice(0, 12)}`);
  } catch {
    return undefined;
  }

  const recipes = new Map<string, { path: string; manifest: RecipeManifest }>();
  for (const recipePath of repo.recipes) {
    const raw = await readManifestAt(rootDir, commit, recipePath, RECIPE_MANIFEST_BASENAME, options);
    if (raw === undefined) continue;
    try {
      const manifest = parseRecipeManifest(raw.value, `${raw.file} at ${commit.slice(0, 12)}`);
      recipes.set(recipeManifestKey(manifest), { path: recipePath, manifest });
    } catch {
      continue;
    }
  }

  return { repo, recipes };
}

/**
 * The manifests the working tree holds, in the same shape a commit's are read
 * into, so the two can be compared.
 *
 * @param validation - The validated repository.
 */
export function snapshotOf(validation: RepoValidation): ManifestSnapshot {
  const recipes = new Map<string, { path: string; manifest: RecipeManifest }>();
  for (const recipe of validation.recipes) {
    recipes.set(recipe.key, { path: recipe.path, manifest: recipe.manifest });
  }
  return { repo: validation.manifest, recipes };
}

/**
 * Compares the manifests a change carries with the ones on the default branch.
 *
 * @param input.baseBranch - The branch the change is compared with, for the record.
 * @param input.base - The manifests on that branch, or undefined when there was nothing to read.
 * @param input.head - The manifests the change carries.
 * @param input.changedPaths - Every path the change touched, relative to the repository root.
 */
export function buildChangelog(input: {
  baseBranch: string;
  base: ManifestSnapshot | undefined;
  head: ManifestSnapshot;
  changedPaths: ReadonlyArray<string>;
}): Changelog {
  const { baseBranch, base, head, changedPaths } = input;
  const changelog: Changelog = {
    baseBranch,
    compared: base !== undefined,
    namespacesAdded: [],
    namespacesRemoved: [],
    recipesAdded: [],
    recipesRemoved: [],
    versionChanges: [],
    unraised: [],
    variables: [],
  };
  if (base === undefined) return changelog;

  const baseNamespaces = Object.keys(base.repo.namespaces);
  const headNamespaces = Object.keys(head.repo.namespaces);
  changelog.namespacesAdded = headNamespaces.filter((name) => !baseNamespaces.includes(name)).sort();
  changelog.namespacesRemoved = baseNamespaces
    .filter((name) => !headNamespaces.includes(name))
    .sort();

  for (const [key, entry] of sortedEntries(head.recipes)) {
    const before = base.recipes.get(key);
    if (before === undefined) {
      changelog.recipesAdded.push({ key, version: entry.manifest.version });
      continue;
    }

    const from = before.manifest.version;
    const to = entry.manifest.version;
    if (from !== to) {
      changelog.versionChanges.push({ key, from, to });
    } else if (pathsInside(entry.path, changedPaths).length > 0) {
      changelog.unraised.push({ key, version: to, next: semver.inc(to, "patch") ?? to });
    }

    changelog.variables.push(
      ...compareVariables(key, before.manifest.variables ?? [], entry.manifest.variables ?? [])
    );
  }

  for (const [key, entry] of sortedEntries(base.recipes)) {
    if (!head.recipes.has(key)) {
      changelog.recipesRemoved.push({ key, version: entry.manifest.version });
    }
  }

  return changelog;
}

/** True when the changelog found nothing that merging would change. */
export function changelogIsEmpty(changelog: Changelog): boolean {
  return (
    changelog.namespacesAdded.length === 0 &&
    changelog.namespacesRemoved.length === 0 &&
    changelog.recipesAdded.length === 0 &&
    changelog.recipesRemoved.length === 0 &&
    changelog.versionChanges.length === 0 &&
    changelog.unraised.length === 0 &&
    changelog.variables.length === 0
  );
}

/** The warning a breaking variable change carries. */
export const BREAKING_VARIABLE_WARNING =
  "Removing a variable or tightening its validation is usually a major change: a " +
  "subscriber's stored answer may no longer be read, or no longer be accepted.";

/**
 * The changelog as Markdown, the way it is appended to a proposal's body and a
 * commit message. Every section is left out when it has nothing to say.
 *
 * @param changelog - The comparison to describe.
 */
export function renderChangelog(changelog: Changelog): string {
  const lines = ["## What merging this changes", ""];

  if (!changelog.compared) {
    lines.push(
      `Sous could not compare this change with the branch '${changelog.baseBranch}', because ` +
        "this checkout holds no copy of it, so no changelog was generated."
    );
    return lines.join("\n");
  }

  lines.push(
    `Generated by \`sous repo submit\` from the manifests this change carries, compared with ` +
      `the branch '${changelog.baseBranch}'.`
  );

  if (changelogIsEmpty(changelog)) {
    lines.push("", "Merging changes no recipe, namespace, version or variable.");
    return lines.join("\n");
  }

  const section = (title: string, entries: string[]) => {
    if (entries.length === 0) return;
    lines.push("", `**${title}**`, "", ...entries.map((entry) => `- ${entry}`));
  };

  section(
    "Recipes added",
    changelog.recipesAdded.map((entry) => `\`${entry.key}\`, at version ${entry.version}`)
  );
  section(
    "Recipes retired",
    changelog.recipesRemoved.map(
      (entry) => `\`${entry.key}\`, last at version ${entry.version}`
    )
  );
  section(
    "Version changes",
    changelog.versionChanges.map(
      (entry) => `\`${entry.key}\`: ${entry.from} becomes ${entry.to}`
    )
  );
  section(
    "Changed without a version raise",
    changelog.unraised.map(
      (entry) =>
        `\`${entry.key}\`: its files changed and its version is still ${entry.version}, so ` +
        `merging releases it as ${entry.next}`
    )
  );
  section("Namespaces added", changelog.namespacesAdded.map((name) => `\`${name}\``));
  section("Namespaces removed", changelog.namespacesRemoved.map((name) => `\`${name}\``));
  section("Variables", changelog.variables.map(describeVariableChange));

  if (changelog.variables.some((entry) => entry.breaking)) {
    lines.push("", `**Warning:** ${BREAKING_VARIABLE_WARNING}`);
  }

  return lines.join("\n");
}

/**
 * Composes a proposal's body: the contributor's own description, then the
 * changelog sous generated.
 *
 * @param description - What the contributor wrote.
 * @param changelog - The comparison to append.
 */
export function composeProposalBody(description: string, changelog: Changelog): string {
  return `${description.trim()}\n\n${renderChangelog(changelog)}\n`;
}

// --- Variables ----------------------------------------------------------------------------------

/**
 * Compares one recipe's variable definitions before and after a change.
 *
 * @param recipe - The recipe key.
 * @param before - The definitions on the default branch.
 * @param after - The definitions the change carries.
 */
export function compareVariables(
  recipe: string,
  before: ReadonlyArray<VariableDefinition>,
  after: ReadonlyArray<VariableDefinition>
): VariableChange[] {
  const changes: VariableChange[] = [];
  const beforeByName = new Map(before.map((definition) => [definition.name, definition]));
  const afterByName = new Map(after.map((definition) => [definition.name, definition]));

  for (const definition of after) {
    const previous = beforeByName.get(definition.name);
    if (previous === undefined) {
      changes.push({ recipe, name: definition.name, change: "added", breaking: false });
      continue;
    }
    const fields = changedFields(previous, definition);
    if (fields.length === 0) continue;
    changes.push({
      recipe,
      name: definition.name,
      change: "changed",
      fields,
      breaking: isTightened(previous, definition),
    });
  }

  for (const definition of before) {
    if (!afterByName.has(definition.name)) {
      changes.push({ recipe, name: definition.name, change: "removed", breaking: true });
    }
  }

  return changes;
}

/**
 * True when a changed definition accepts less than it did: a different type, a
 * newly required answer, or a validation rule that rejects something the old
 * one accepted. A changed pattern counts, since sous cannot prove one regular
 * expression accepts everything another did.
 *
 * isTightened({ ..., validate: { maxLength: 10 } }, { ..., validate: { maxLength: 5 } });
 * // -> true
 *
 * @param before - The definition on the default branch.
 * @param after - The definition the change carries.
 */
export function isTightened(before: VariableDefinition, after: VariableDefinition): boolean {
  if (before.type !== after.type) return true;
  if (!before.required && after.required) return true;

  const was = before.validate ?? {};
  const now = after.validate ?? {};

  if (now.pattern !== undefined && now.pattern !== was.pattern) return true;
  if (raised(was.minLength, now.minLength)) return true;
  if (lowered(was.maxLength, now.maxLength)) return true;
  if (raised(was.min, now.min)) return true;
  if (lowered(was.max, now.max)) return true;
  if (now.enum !== undefined) {
    if (was.enum === undefined) return true;
    if (was.enum.some((option) => !now.enum!.includes(option))) return true;
  }
  return false;
}

/** True when a lower bound was added or moved up. */
function raised(was: number | undefined, now: number | undefined): boolean {
  return now !== undefined && (was === undefined || now > was);
}

/** True when an upper bound was added or moved down. */
function lowered(was: number | undefined, now: number | undefined): boolean {
  return now !== undefined && (was === undefined || now < was);
}

/** The top-level fields of a definition that differ, by name, in a stable order. */
function changedFields(before: VariableDefinition, after: VariableDefinition): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const fields: string[] = [];
  for (const key of [...keys].sort()) {
    const was = (before as Record<string, unknown>)[key];
    const now = (after as Record<string, unknown>)[key];
    if (JSON.stringify(was) !== JSON.stringify(now)) fields.push(key);
  }
  return fields;
}

/** One variable change, as a changelog line. */
function describeVariableChange(entry: VariableChange): string {
  const subject = `\`${entry.recipe}\`: the variable \`${entry.name}\``;
  if (entry.change === "added") return `${subject} was added`;
  if (entry.change === "removed") return `${subject} was removed (usually a major change)`;
  const fields = (entry.fields ?? []).map((field) => `\`${field}\``).join(", ");
  return (
    `${subject} changed its ${fields}` +
    (entry.breaking ? " and now accepts less than before (usually a major change)" : "")
  );
}

// --- Reading at a commit ------------------------------------------------------------------------

/**
 * Reads one manifest at a commit, trying each supported file name in turn.
 *
 * @param rootDir - The repository's root directory.
 * @param commit - The commit to read at.
 * @param folder - The folder holding it, relative to the repository root ("" for the root).
 * @param basename - The manifest's name without an extension.
 * @param options - The command runner to use.
 */
async function readManifestAt(
  rootDir: string,
  commit: string,
  folder: string,
  basename: string,
  options: RunOptions
): Promise<{ file: string; value: unknown } | undefined> {
  for (const extension of MANIFEST_EXTENSIONS) {
    const file = folder.length === 0 ? `${basename}${extension}` : path.posix.join(folder, `${basename}${extension}`);
    const text = await readFileAtTag(rootDir, commit, file, options);
    if (text === undefined) continue;
    try {
      const value =
        extension === ".yaml" || extension === ".yml"
          ? parseYamlText(text, file)
          : parseJsoncText(text, file);
      return { file, value };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** A map's entries, sorted by key, so the changelog reads the same every time. */
function sortedEntries<T>(map: Map<string, T>): Array<[string, T]> {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
