/**
 * Scaffolding a new recipe repository, which is what `sous repo init` does.
 *
 * The scaffold is built in memory first, validated with the very parsers sous
 * uses to read a real repository, and only then written to disk. A scaffold
 * that sous itself cannot read would be worse than no scaffold at all, so
 * `scaffoldRepo` reads every manifest back after writing it and reports the
 * failure against the file it just produced.
 */

import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "../../errors.js";
import {
  INDEX_FILENAME,
  MANIFEST_EXTENSIONS,
  RECIPE_MANIFEST_BASENAME,
  REPO_MANIFEST_BASENAME,
} from "../formats/common.js";
import { parseIndexFile } from "../formats/index-file.js";
import { parseRecipeManifest } from "../formats/recipe-manifest.js";
import { parseRepoManifest } from "../formats/repo-manifest.js";
import { findRepoManifest, loadJsonFile, loadManifestFile } from "../load-manifest.js";
import {
  buildExampleSkill,
  buildGitignore,
  buildIndexFile,
  buildReadme,
  buildRecipeManifest,
  buildReleaseWorkflow,
  buildRepoManifest,
  exampleRecipePath,
  type ScaffoldContext,
} from "./templates.js";

export * from "./templates.js";

/** The name given to the one example recipe every scaffold writes. */
export const EXAMPLE_RECIPE_NAME = "example";

/** What to scaffold, and where. */
export type ScaffoldOptions = {
  /** Absolute path to the directory the repository is created in. */
  directory: string;
  /** The repository's short name. Defaults to the directory's own name. */
  name?: string;
  /** The one namespace to declare. Defaults to the repository's name. */
  namespace?: string;
  /** Overwrite an existing repository rather than refusing to touch it. */
  force?: boolean;
  /** Work out every file and validate the plan, but write nothing. */
  dryRun?: boolean;
  /** The version of sous recorded in the generated index. */
  sousVersion: string;
  /** When the scaffold ran, recorded in the generated index. Defaults to now. */
  now?: Date;
};

/** What a scaffold produced. */
export type ScaffoldResult = {
  /** The directory the repository was created in. */
  directory: string;
  /** The repository's short name. */
  name: string;
  /** The namespace that was declared. */
  namespace: string;
  /** Paths of every file, relative to the directory, in the order they were written. */
  files: string[];
  /** True when nothing was actually written. */
  dryRun: boolean;
};

/** One planned file: where it goes, and what goes in it. */
type PlannedFile = {
  /** Path relative to the repository root. */
  relativePath: string;
  /** The complete file contents. */
  contents: string;
};

/**
 * Creates a new recipe repository: a repo manifest, one example recipe with a
 * placeholder skill, an empty but valid index, a README, release automation and
 * a `.gitignore`.
 *
 * @param options - What to scaffold, and where.
 */
export function scaffoldRepo(options: ScaffoldOptions): ScaffoldResult {
  const directory = path.resolve(options.directory);
  const name = normalizeName(options.name ?? path.basename(directory), "--name");
  const namespace = normalizeName(options.namespace ?? name, "--namespace");
  const dryRun = options.dryRun === true;

  assertNoExistingRepo(directory, options.force === true);

  const context: ScaffoldContext = {
    name,
    namespace,
    recipe: EXAMPLE_RECIPE_NAME,
    sousVersion: options.sousVersion,
    generatedAt: (options.now ?? new Date()).toISOString(),
  };

  const files = planFiles(context);

  if (!dryRun) {
    for (const file of files) {
      const target = path.join(directory, file.relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.contents, "utf8");
    }
    verifyScaffold(directory, context);
  }

  return {
    directory,
    name,
    namespace,
    files: files.map((file) => file.relativePath),
    dryRun,
  };
}

/** Builds every file the scaffold writes, in the order they are written. */
function planFiles(context: ScaffoldContext): PlannedFile[] {
  const recipeDir = exampleRecipePath(context);
  return [
    {
      relativePath: `${REPO_MANIFEST_BASENAME}${MANIFEST_EXTENSIONS[0]}`,
      contents: buildRepoManifest(context),
    },
    {
      relativePath: INDEX_FILENAME,
      contents: buildIndexFile(context),
    },
    {
      relativePath: `${recipeDir}/${RECIPE_MANIFEST_BASENAME}${MANIFEST_EXTENSIONS[0]}`,
      contents: buildRecipeManifest(context),
    },
    {
      relativePath: `${recipeDir}/skills/example-skill/SKILL.md`,
      contents: buildExampleSkill(context),
    },
    { relativePath: "README.md", contents: buildReadme(context) },
    {
      relativePath: ".github/workflows/sous-release.yml",
      contents: buildReleaseWorkflow(),
    },
    { relativePath: ".gitignore", contents: buildGitignore() },
  ];
}

/**
 * Refuses to scaffold over a repository that already exists, unless the caller
 * asked to. The manifest is the thing that makes a directory a repository, so
 * that is what is checked; an ordinary directory with unrelated files in it is
 * a perfectly reasonable place to create one.
 */
function assertNoExistingRepo(directory: string, force: boolean): void {
  if (force) return;

  const existing = findRepoManifest(directory);
  if (existing !== undefined) {
    throw new ConfigError(
      `${directory} is already a sous repository.\n` +
        `  It holds ${path.basename(existing)}, which sous will not overwrite.\n` +
        `  Pass --force to write the scaffold over it, or choose another directory.`
    );
  }
}

/**
 * Reads back every file that has to parse, using the same loaders and schemas
 * that read a published repository, so a scaffold is never reported as a
 * success unless sous can actually read it.
 */
function verifyScaffold(directory: string, context: ScaffoldContext): void {
  const manifestPath = path.join(
    directory,
    `${REPO_MANIFEST_BASENAME}${MANIFEST_EXTENSIONS[0]}`
  );
  const manifest = parseRepoManifest(loadManifestFile(manifestPath), manifestPath);

  const indexPath = path.join(directory, INDEX_FILENAME);
  parseIndexFile(loadJsonFile(indexPath, "repo index"), indexPath);

  for (const recipePath of manifest.recipes) {
    const recipeManifestPath = path.join(
      directory,
      recipePath,
      `${RECIPE_MANIFEST_BASENAME}${MANIFEST_EXTENSIONS[0]}`
    );
    const recipe = parseRecipeManifest(
      loadManifestFile(recipeManifestPath),
      recipeManifestPath
    );

    if (!Object.hasOwn(manifest.namespaces, recipe.namespace)) {
      throw new ConfigError(
        `The scaffold in ${directory} is inconsistent.\n` +
          `  The recipe at ${recipePath} declares the namespace ` +
          `'${recipe.namespace}', which ${REPO_MANIFEST_BASENAME}` +
          `${MANIFEST_EXTENSIONS[0]} does not declare.\n` +
          `  This is a bug in sous; please report it.`
      );
    }
  }

  if (manifest.name !== context.name) {
    throw new ConfigError(
      `The scaffold in ${directory} is inconsistent: the repo manifest names it ` +
        `'${manifest.name}' rather than '${context.name}'.\n` +
        `  This is a bug in sous; please report it.`
    );
  }
}

/**
 * Checks that a name sous is about to write into a manifest is a name the
 * manifest schema accepts, and says how to fix it when it is not. Lower-cases
 * the value first, so a directory called `My-Recipes` yields `my-recipes`
 * instead of an error.
 */
function normalizeName(value: string, flagName: string): string {
  const normalized = value.trim().toLowerCase();

  if (!/^[a-z][a-z0-9-]*$/.test(normalized)) {
    throw new ConfigError(
      `'${value}' cannot be used as a name here.\n` +
        `  A repository name and a namespace name are lowercase kebab-case: a ` +
        `letter, then letters, digits or hyphens (for example 'sous-recipes').\n` +
        `  Pass ${flagName} to choose one, or run the command in a directory whose ` +
        `own name fits.`
    );
  }

  return normalized;
}
