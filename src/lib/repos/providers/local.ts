/**
 * The local provider: a repository that lives on this machine.
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
 * A relative path (`../my-recipes`, `~/my-recipes`) is what people actually
 * type, so `sous repo add` and `sous repo link` run it through
 * `resolveRepoArgument` before any provider sees it and store the absolute
 * result. The provider itself still matches absolute paths only, because a
 * stored entry is read from a config file that several working directories may
 * run against.
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
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConfigError } from "../../errors.js";
import {
  INDEX_FILENAME,
  MANIFEST_EXTENSIONS,
  REPO_MANIFEST_BASENAME,
} from "../formats/common.js";
import { findRepoManifest } from "../load-manifest.js";
import { ProviderBase } from "./base.js";
import { fetchSubtree, runGit, tryCommand, type CommandRunner } from "./git.js";
import type {
  CanonicalRepo,
  FetchedIndex,
  ProviderFeature,
  ProviderOptions,
} from "./provider.js";

/** The identifier a repository entry uses to name this provider explicitly. */
export const LOCAL_PROVIDER_ID = "local" as const;

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

/** A URL that names its scheme, such as `https://` or `ssh://`. */
const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

/** The `scp`-style SSH form people paste, as in `git@github.com:owner/name.git`. */
const SCP_PATTERN = /^[^@\s/\\]+@[^@\s/\\:]+:.+$/;

/** A Windows absolute path, as in `C:\Projects\recipes`. */
const WINDOWS_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/;

/**
 * Expands a leading `~` to the current user's home directory. Only a bare `~`
 * or a `~/...` prefix is expanded; `~other/x` is left alone, because sous does
 * not look other people's home directories up.
 *
 * @param value - The path as typed.
 */
export function expandHomePath(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/**
 * True when a repository argument is a filesystem path rather than a URL to a
 * host. A `file://` URL, an absolute path, a `~` path and an explicitly
 * relative path (`./x`, `../x`, `.`, `..`) all count outright. A bare segment
 * such as `my-recipes` counts only when a directory of that name really is
 * there, so a host name is never mistaken for a folder.
 *
 * looksLikeLocalPath("../my-recipes"); // -> true
 * looksLikeLocalPath("https://github.com/o/r"); // -> false
 *
 * @param value - The repository argument, as typed.
 * @param cwd - The directory a relative path is measured from. Defaults to the working directory.
 */
export function looksLikeLocalPath(value: string, cwd: string = process.cwd()): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;

  if (trimmed.toLowerCase().startsWith("file://")) return true;
  if (SCHEME_PATTERN.test(trimmed)) return false;

  const expanded = expandHomePath(trimmed);
  if (path.isAbsolute(expanded) || WINDOWS_ABSOLUTE_PATTERN.test(expanded)) return true;
  if (expanded !== trimmed) return true;

  if (
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith(".\\") ||
    trimmed.startsWith("..\\")
  ) {
    return true;
  }

  if (SCP_PATTERN.test(trimmed)) return false;

  try {
    return fs.statSync(path.resolve(cwd, trimmed)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Normalizes a repository argument before any provider looks at it: a path is
 * expanded and resolved to an absolute one, and anything else is handed back
 * unchanged. The absolute form is what gets stored, because a repository on
 * this machine is machine-specific whichever way it was typed.
 *
 * resolveRepoArgument("../my-recipes", "/home/me/work"); // -> "/home/me/my-recipes"
 * resolveRepoArgument("https://github.com/o/r");         // -> unchanged
 *
 * @param value - The repository argument, as typed.
 * @param cwd - The directory a relative path is measured from. Defaults to the working directory.
 */
export function resolveRepoArgument(value: string, cwd: string = process.cwd()): string {
  const trimmed = value.trim();
  if (!looksLikeLocalPath(trimmed, cwd)) return trimmed;

  if (trimmed.toLowerCase().startsWith("file://")) {
    const direct = localRepoPath(trimmed);
    return direct ?? trimmed;
  }

  return path.resolve(cwd, expandHomePath(trimmed));
}

/**
 * Checks that a resolved local path really is a sous repository, and explains
 * the path itself when it is not. A person who typed a path made a path
 * mistake, so the message names what they typed, where sous looked, and what
 * it expected to find there; providers do not come into it.
 *
 * @param typed - The path exactly as the user typed it.
 * @param resolved - The absolute path sous resolved it to.
 */
export function assertLocalRepoDirectory(typed: string, resolved: string): void {
  const manifestName = `${REPO_MANIFEST_BASENAME}${MANIFEST_EXTENSIONS[0]}`;
  const spellings = MANIFEST_EXTENSIONS.map(
    (extension) => `${REPO_MANIFEST_BASENAME}${extension}`
  ).join(", ");

  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new ConfigError(
      `There is no directory at '${typed}'.\n` +
        `  Sous read that as the path ${resolved}, and nothing is there.\n` +
        `  A repository on this machine is a directory holding a '${manifestName}' ` +
        `file at its root. Check the path, or create one with 'sous repo init'.`
    );
  }

  if (!stats.isDirectory()) {
    throw new ConfigError(
      `'${typed}' is a file, not a directory.\n` +
        `  Sous read that as the path ${resolved}.\n` +
        `  Name the root directory of a repository: the directory holding its ` +
        `'${manifestName}' file.`
    );
  }

  if (findRepoManifest(resolved) === undefined) {
    throw new ConfigError(
      `The directory '${typed}' is not a sous repository.\n` +
        `  Sous read that as the path ${resolved}, and it holds no repository ` +
        `manifest.\n` +
        `  A repository declares itself with one of ${spellings} at its root. ` +
        `Check the path, or create a repository there with 'sous repo init'.`
    );
  }
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

/** The repository that a local provider call is reading. */
function repoDirectory(repo: CanonicalRepo): string {
  return repo.httpsUrl;
}

/** A repository on this machine, read as though it were a hosted one. */
export class LocalProvider extends ProviderBase {
  readonly id = LOCAL_PROVIDER_ID;

  /**
   * Proposing a change to a directory on your own disk is just editing it, so
   * this provider declares no `submit` feature and has no command line tool.
   * The write-path calls it inherits from ProviderBase all refuse, naming the
   * provider and the feature.
   */
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
