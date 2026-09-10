/**
 * The file provider: a repository that lives on this machine.
 *
 * It exists for local development and for tests. A recipe repository under
 * development, or a fixture repository built by a test, is an ordinary
 * directory; this provider reads one exactly the way the hosted providers read
 * a remote, so everything above it (trust, the resolver, the store, the
 * lockfile, the build) runs unchanged and without a network.
 *
 * TRUST SEMANTICS ARE IDENTICAL. A local path is added, and therefore trusted,
 * through the same ceremony as any other repository; sous reads nothing from a
 * directory a project has not added. "It is on my disk already" is not a reason
 * to skip the question, because the recipes in it still run on this machine.
 *
 * Two URL forms are accepted, and they mean the same thing:
 *
 *     file:///home/me/Projects/my-recipes
 *     /home/me/Projects/my-recipes
 *
 * The index is read from the working tree when the file is there, so an
 * uncommitted index is picked up while a repository is being authored, and from
 * `git show HEAD:sous.index.json` otherwise. A recipe's files come from
 * `git clone --branch <tag>` of the local path, which is the same sparse,
 * blobless fetch the hosted providers use; a directory that is not a git
 * repository (or a tag that does not exist in it) falls back to copying the
 * recipe folder out of the working tree.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConfigError } from "../../errors.js";
import { INDEX_FILENAME } from "../formats/common.js";
import { fetchSubtree, runGit, tryCommand, type CommandRunner } from "./git.js";
import type {
  CanonicalRepo,
  FetchedIndex,
  ProviderFeature,
  ProviderOptions,
  RepoProvider,
} from "./provider.js";

/** The identifier a repository entry uses to name this provider explicitly. */
export const FILE_PROVIDER_ID = "file" as const;

/**
 * The absolute directory a repository URL names, or undefined when the URL is
 * not a local path at all. Both the `file://` form and a bare absolute path are
 * accepted; a relative path is not, because a repository entry is read from a
 * config file that several working directories may run against.
 *
 * localRepoPath("file:///home/me/recipes"); // -> "/home/me/recipes"
 * localRepoPath("https://github.com/o/r");  // -> undefined
 *
 * @param url - The repository URL, as configured.
 */
export function localRepoPath(url: string): string | undefined {
  const trimmed = url.trim();
  if (trimmed.length === 0) return undefined;

  if (trimmed.toLowerCase().startsWith("file://")) {
    try {
      return path.normalize(fileURLToPath(trimmed));
    } catch {
      return undefined;
    }
  }

  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : undefined;
}

/** True when a directory is the root of a git repository or a working tree of one. */
async function isGitRepository(
  directory: string,
  run?: CommandRunner
): Promise<boolean> {
  const found = await tryCommand("git", ["-C", directory, "rev-parse", "--git-dir"], {
    ...(run === undefined ? {} : { run }),
  });
  return found !== undefined;
}

/** True when a git repository holds the named tag. */
async function hasTag(
  directory: string,
  tag: string,
  run?: CommandRunner
): Promise<boolean> {
  const found = await tryCommand(
    "git",
    ["-C", directory, "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`],
    { ...(run === undefined ? {} : { run }) }
  );
  return found !== undefined;
}

/** The repository that a file provider call is reading. */
function repoDirectory(repo: CanonicalRepo): string {
  return repo.httpsUrl;
}

/** A repository on this machine, read as though it were a hosted one. */
export class FileProvider implements RepoProvider {
  readonly id = FILE_PROVIDER_ID;

  /** Proposing a change to a directory on your own disk is just editing it. */
  readonly features: ProviderFeature[] = ["fetch"];

  matches(url: string): boolean {
    return localRepoPath(url) !== undefined;
  }

  /**
   * Takes a local repository path apart. `httpsUrl` carries the absolute
   * directory rather than a URL, because that is what git is handed when a
   * recipe is fetched; `sshUrl` carries the canonical `file://` spelling, so a
   * caller that wants to show the URL back to a person has one.
   *
   * @param url - The repository URL or path, as configured.
   */
  canonicalize(url: string): CanonicalRepo {
    const directory = localRepoPath(url);
    if (directory === undefined) {
      throw new ConfigError(
        `'${url}' is not a local repository path that sous can read.\n` +
          `  A local repository is named by an absolute path, or by the same path in ` +
          `'file:///...' form. A relative path is not accepted, because a repository ` +
          `entry is read from a config file that several working directories may run ` +
          `against.`
      );
    }

    return {
      host: "localhost",
      owner: path.dirname(directory),
      name: path.basename(directory),
      httpsUrl: directory,
      sshUrl: pathToFileURL(directory).href,
    };
  }

  /**
   * Reads the repository's index: the working tree's copy when there is one, so
   * an index being authored right now is picked up, and the committed copy
   * otherwise.
   *
   * @param repo - The canonicalized repository.
   * @param options - Subprocess runner override.
   */
  async fetchIndex(
    repo: CanonicalRepo,
    options: ProviderOptions = {}
  ): Promise<FetchedIndex> {
    const directory = repoDirectory(repo);

    if (!fs.existsSync(directory)) {
      throw new ConfigError(
        `There is no directory at ${directory}.\n` +
          `  This project reads a repository from that path, and it is not there. ` +
          `Either the checkout moved, or the repository entry names the wrong place.`
      );
    }

    const working = path.join(directory, INDEX_FILENAME);
    if (fs.existsSync(working)) {
      return { text: await fsp.readFile(working, "utf8"), ref: "working tree" };
    }

    if (!(await isGitRepository(directory, options.run))) {
      throw new ConfigError(
        `The directory ${directory} publishes no sous index.\n` +
          `  A repository publishes '${INDEX_FILENAME}' at its root, written by ` +
          `'sous repo release'. This directory has none, and it is not a git ` +
          `repository, so there is no committed copy to read either.`
      );
    }

    const text = await runGit(
      ["-C", directory, "show", `HEAD:${INDEX_FILENAME}`],
      { ...(options.run === undefined ? {} : { run: options.run }) }
    );
    return { text, ref: "HEAD" };
  }

  /**
   * Fetches one recipe folder at one tag. A git repository is cloned at the tag,
   * exactly as a hosted repository would be, so a version really is the version
   * the tag points at. A plain directory has no versions to honour, so its
   * working tree is copied instead.
   *
   * @param repo - The canonicalized repository.
   * @param recipePath - The recipe folder, relative to the repository root.
   * @param tag - The git tag carrying the version.
   * @param destDir - Where the recipe's files should end up.
   * @param options - Subprocess runner override.
   */
  async fetchRecipeTree(
    repo: CanonicalRepo,
    recipePath: string,
    tag: string,
    destDir: string,
    options: ProviderOptions = {}
  ): Promise<void> {
    const directory = repoDirectory(repo);

    if (
      (await isGitRepository(directory, options.run)) &&
      (await hasTag(directory, tag, options.run))
    ) {
      await fetchSubtree({
        cloneUrl: directory,
        tag,
        subPath: recipePath,
        destDir,
        ...(options.run === undefined ? {} : { run: options.run }),
      });
      return;
    }

    const source = path.join(directory, recipePath);
    if (!fs.existsSync(source)) {
      throw new ConfigError(
        `The repository at ${directory} has no folder '${recipePath}'.\n` +
          `  Its index says the recipe lives there, so either the index is out of date ` +
          `or the folder has been moved.`
      );
    }

    await fsp.rm(destDir, { recursive: true, force: true });
    await fsp.mkdir(path.dirname(destDir), { recursive: true });
    await fsp.cp(source, destDir, { recursive: true });
  }
}
