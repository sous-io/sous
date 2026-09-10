/**
 * Builds a real, local recipe repository on disk for the integration tests.
 *
 * The result is a git repository with a repo manifest, one recipe manifest per
 * recipe, a generated index carrying the real content hash of every recipe
 * folder, and one tag per published version. That is exactly what the `file`
 * provider reads, so a test drives the whole system end to end with no network.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { hashDirectory } from "../../lib/repos/store/hash.js";

/** Writes a file, creating its parent directories. Returns the full path. */
export function writeFixtureFile(filePath: string, contents: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

/** Runs git in a directory, with an identity so committing works anywhere. */
export function gitIn(cwd: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Sous Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Sous Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
}

/** One recipe to write into a fixture repository. */
export type RecipeFixture = {
  namespace: string;
  name: string;
  version: string;
  description?: string;
  depends?: string[];
  files: Record<string, string>;
  variables?: unknown[];
  /** The recipe's `contents` block; defaults to a single skills entry. */
  contents?: unknown[];
};

/**
 * Builds a local git repository publishing the given recipes.
 *
 * @param directory - Where to build it; created if it does not exist.
 * @param name - The repository's short name, used in its manifest and index.
 * @param recipes - The recipes to publish.
 */
export async function buildFixtureRepo(
  directory: string,
  name: string,
  recipes: RecipeFixture[]
): Promise<void> {
  const namespaces: Record<string, unknown> = {};
  const indexRecipes: Record<string, unknown> = {};
  const paths: string[] = [];

  for (const recipe of recipes) {
    const relative = `recipes/${recipe.namespace}/${recipe.name}`;
    const recipeDir = path.join(directory, relative);
    paths.push(relative);
    namespaces[recipe.namespace] = { description: `The ${recipe.namespace} namespace` };

    writeFixtureFile(
      path.join(recipeDir, "sous.recipe.json"),
      JSON.stringify(
        {
          formatVersion: 1,
          namespace: recipe.namespace,
          name: recipe.name,
          version: recipe.version,
          ...(recipe.description === undefined ? {} : { description: recipe.description }),
          ...(recipe.depends === undefined ? {} : { depends: recipe.depends }),
          contents: recipe.contents ?? [{ kind: "skills", include: ["skills/**/*.md"] }],
          ...(recipe.variables === undefined ? {} : { variables: recipe.variables }),
        },
        null,
        2
      )
    );

    for (const [relativeFile, contents] of Object.entries(recipe.files)) {
      writeFixtureFile(path.join(recipeDir, relativeFile), contents);
    }
  }

  writeFixtureFile(
    path.join(directory, "sous.repo.json"),
    JSON.stringify({ formatVersion: 1, name, namespaces, recipes: paths }, null, 2)
  );

  // The index carries the real content hash of each recipe folder, which the
  // store verifies after every fetch, so it has to be computed from the files
  // that were just written.
  for (const recipe of recipes) {
    const relative = `recipes/${recipe.namespace}/${recipe.name}`;
    const hash = await hashDirectory(path.join(directory, relative));
    indexRecipes[`${recipe.namespace}/${recipe.name}`] = {
      path: relative,
      ...(recipe.description === undefined ? {} : { description: recipe.description }),
      versions: {
        [recipe.version]: {
          hash,
          tag: `${recipe.namespace}/${recipe.name}@${recipe.version}`,
          prerelease: false,
          releasedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    };
  }

  writeFixtureFile(
    path.join(directory, "sous.index.json"),
    JSON.stringify(
      {
        formatVersion: 1,
        name,
        generatedAt: "2026-01-01T00:00:00.000Z",
        generator: "0.1.1",
        namespaces,
        recipes: indexRecipes,
      },
      null,
      2
    )
  );

  gitIn(directory, "init", "--quiet", "--initial-branch", "main");
  gitIn(directory, "add", "-A");
  gitIn(directory, "commit", "--quiet", "-m", "Publish the fixture recipes");
  for (const recipe of recipes) {
    gitIn(directory, "tag", `${recipe.namespace}/${recipe.name}@${recipe.version}`);
  }
}
