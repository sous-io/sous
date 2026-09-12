/**
 * Git tags as the cheap enumeration path for published recipe versions.
 *
 * Recipe metadata is the source of truth for versions; a tag shaped
 * `namespace/recipe@1.2.3` is a convenience ref that points at the commit the
 * version was published from. The two must agree, and this module is what makes
 * that checkable: it names tags, lists them, reads a file back out of one, and
 * materializes a tagged recipe folder so its content can be hashed.
 *
 * Every function takes the injectable command runner, so a test drives the whole
 * surface against a repository made with `git init` and never reaches a network.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit, type RunOptions } from "../providers/git.js";
import { RECIPE_KEY_PATTERN } from "../formats/patterns.js";

/** One release tag, taken apart into the recipe it publishes. */
export type RecipeTag = {
  /** The tag exactly as git holds it, `namespace/recipe@version`. */
  tag: string;
  /** The recipe's namespace. */
  namespace: string;
  /** The recipe's name. */
  name: string;
  /** The exact version the tag publishes. */
  version: string;
};

/** The recipe key (`namespace/recipe`) a tag belongs to. */
export function recipeTagKey(tag: RecipeTag): string {
  return `${tag.namespace}/${tag.name}`;
}

/**
 * The tag that publishes one version of one recipe.
 *
 * @param namespace - The recipe's namespace.
 * @param name - The recipe's name.
 * @param version - The exact version being published.
 */
export function tagFor(namespace: string, name: string, version: string): string {
  return `${namespace}/${name}@${version}`;
}

/**
 * Takes a tag apart, or returns undefined when it is not a recipe release tag.
 * A repository may carry tags of its own shape (`v1.2.0`, say), and those are
 * simply not ours.
 *
 * @param tag - The tag name as git holds it.
 */
export function parseRecipeTag(tag: string): RecipeTag | undefined {
  const at = tag.lastIndexOf("@");
  if (at <= 0 || at === tag.length - 1) return undefined;

  const key = tag.slice(0, at);
  const version = tag.slice(at + 1);
  if (!RECIPE_KEY_PATTERN.test(key)) return undefined;

  const slash = key.indexOf("/");
  return {
    tag,
    namespace: key.slice(0, slash),
    name: key.slice(slash + 1),
    version,
  };
}

/**
 * Every recipe release tag in a repository, in the order git lists them. Tags
 * that are not shaped like a recipe release are left out.
 *
 * @param rootDir - The repository's root directory.
 * @param options - The command runner to use.
 */
export async function listRecipeTags(
  rootDir: string,
  options: RunOptions = {}
): Promise<RecipeTag[]> {
  const output = await runGit(["tag", "--list", "*@*"], {
    cwd: rootDir,
    run: options.run,
  });
  if (output.length === 0) return [];

  const tags: RecipeTag[] = [];
  for (const line of output.split("\n")) {
    const parsed = parseRecipeTag(line.trim());
    if (parsed !== undefined) tags.push(parsed);
  }
  return tags;
}

/**
 * The contents of one file as it stood at a tag, or undefined when the tag does
 * not carry that file.
 *
 * @param rootDir - The repository's root directory.
 * @param tag - The tag to read at.
 * @param relativePath - The file's path relative to the repository root.
 * @param options - The command runner to use.
 */
export async function readFileAtTag(
  rootDir: string,
  tag: string,
  relativePath: string,
  options: RunOptions = {}
): Promise<string | undefined> {
  try {
    return await runGit(["show", `${tag}:${toPosix(relativePath)}`], {
      cwd: rootDir,
      run: options.run,
    });
  } catch {
    return undefined;
  }
}

/**
 * When the commit a tag points at was made, as an ISO 8601 timestamp, or
 * undefined when git cannot say.
 *
 * @param rootDir - The repository's root directory.
 * @param tag - The tag to date.
 * @param options - The command runner to use.
 */
export async function tagCommitDate(
  rootDir: string,
  tag: string,
  options: RunOptions = {}
): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await runGit(["log", "-1", "--format=%cI", tag], {
      cwd: rootDir,
      run: options.run,
    });
  } catch {
    return undefined;
  }

  const parsed = new Date(raw.trim());
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

/**
 * Checks out the tree at a tag into a temporary directory, hands the caller the
 * path of one folder inside it, and cleans up afterwards.
 *
 * A linked worktree is used rather than `git archive` piped into a tar reader:
 * the command runner captures output as text, so an archive's bytes could not
 * survive the trip, while a worktree puts the real files on disk where they can
 * be read and hashed exactly as a fetched copy would be.
 *
 * @param rootDir - The repository's root directory.
 * @param tag - The tag to check out.
 * @param subPath - The folder inside the tree to hand back, relative to the root.
 * @param use - Called with the absolute path of that folder.
 * @param options - The command runner to use.
 */
export async function withTaggedTree<T>(
  rootDir: string,
  tag: string,
  subPath: string,
  use: (dir: string) => Promise<T>,
  options: RunOptions = {}
): Promise<T> {
  const workRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sous-release-"));
  const checkout = path.join(workRoot, "tree");

  try {
    await runGit(["worktree", "add", "--detach", "--quiet", checkout, tag], {
      cwd: rootDir,
      run: options.run,
    });
    return await use(path.join(checkout, ...toPosix(subPath).split("/")));
  } finally {
    // Remove the worktree through git first, so its administrative record goes
    // with it; a plain delete would leave the repository listing a worktree
    // that is no longer there.
    try {
      await runGit(["worktree", "remove", "--force", checkout], {
        cwd: rootDir,
        run: options.run,
      });
    } catch {
      // The worktree was never created, or git already dropped it. Either way
      // the temporary directory below is what actually needs removing.
    }
    await fs.rm(workRoot, { recursive: true, force: true });
  }
}

/**
 * Creates an annotated tag on HEAD.
 *
 * @param rootDir - The repository's root directory.
 * @param tag - The tag to create.
 * @param message - The tag's annotation message.
 * @param options - The command runner to use.
 */
export async function createAnnotatedTag(
  rootDir: string,
  tag: string,
  message: string,
  options: RunOptions = {}
): Promise<void> {
  await runGit(["tag", "--annotate", tag, "--message", message], {
    cwd: rootDir,
    run: options.run,
  });
}

/**
 * Pushes exactly the named tags to a remote, and nothing else. Sous never
 * pushes a branch as a side effect of tagging.
 *
 * @param rootDir - The repository's root directory.
 * @param remote - The remote to push to, normally `origin`.
 * @param tags - The tags to push.
 * @param options - The command runner to use.
 */
export async function pushTags(
  rootDir: string,
  remote: string,
  tags: ReadonlyArray<string>,
  options: RunOptions = {}
): Promise<void> {
  if (tags.length === 0) return;
  await runGit(["push", remote, ...tags.map((tag) => `refs/tags/${tag}`)], {
    cwd: rootDir,
    run: options.run,
  });
}

/** Rewrites a path with forward slashes, which is what git speaks everywhere. */
function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
