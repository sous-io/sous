/**
 * The thin git layer used by `sous repo link`.
 *
 * Linking a repository sometimes means cloning it, and always means asking
 * whether a directory already on disk is the right checkout. Both jobs are done
 * by shelling out to the user's own `git`, rather than by bundling a git
 * implementation: the user's credentials, SSH agent, proxy settings and
 * `insteadOf` rewrites are already configured there, and sous inheriting all of
 * that for free is worth more than any library.
 *
 * Every function takes an optional `runner`, so tests can drive the whole
 * surface without a real git or a network connection.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ConfigError } from "../errors.js";

/** What one git invocation produced. */
export type GitResult = {
  /** The process exit code, or null when it was killed by a signal. */
  status: number | null;
  /** Everything git wrote to standard output, trimmed. */
  stdout: string;
  /** Everything git wrote to standard error, trimmed. */
  stderr: string;
};

/**
 * Runs one git command. Swappable so tests never need a real git binary.
 *
 * @param args - The arguments passed to git, without the leading "git".
 * @param options - Where to run it.
 */
export type GitRunner = (args: string[], options: { cwd?: string }) => GitResult;

/** Options shared by every function here. */
export type GitOptions = {
  /** The git runner to use. Defaults to the real `git` on PATH. */
  runner?: GitRunner;
};

/**
 * The default runner: invokes the real `git` on PATH and captures its output.
 *
 * @param args - The arguments passed to git, without the leading "git".
 * @param options - Where to run it.
 */
export const runGit: GitRunner = (args, options = {}) => {
  const result = spawnSync("git", args, {
    cwd: options.cwd,
    encoding: "utf8",
    // A clone must never stop to ask for a password; a prompt in a
    // non-interactive run would hang the command with no explanation.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });

  if (result.error !== undefined) {
    const reason = (result.error as NodeJS.ErrnoException).code === "ENOENT"
      ? "git is not installed, or is not on your PATH"
      : result.error.message;
    throw new ConfigError(
      `Could not run git.\n` +
        `  ${reason}.\n` +
        `  sous uses your own git so that your credentials and configuration apply; ` +
        `install git and try again.`
    );
  }

  return {
    status: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
};

/** Runs git and throws a ConfigError, carrying git's own message, on failure. */
function runGitOrThrow(
  args: string[],
  options: { cwd?: string; runner?: GitRunner; what: string }
): GitResult {
  const runner = options.runner ?? runGit;
  const result = runner(args, { cwd: options.cwd });
  if (result.status !== 0) {
    const detail = result.stderr.length > 0 ? result.stderr : result.stdout;
    throw new ConfigError(
      `${options.what} failed.\n` +
        `  Command: git ${args.join(" ")}\n` +
        (detail.length > 0 ? `  git said: ${detail}\n` : "") +
        `  Fix the problem git reported, then run the command again.`
    );
  }
  return result;
}

/**
 * True when the directory is inside a git working tree whose root is that same
 * directory. A subdirectory of a checkout is deliberately not a checkout here:
 * linking half a repository would silently produce a repo with no manifest at
 * its root.
 *
 * @param directory - The directory to test.
 * @param options - The git runner to use.
 */
export function isGitCheckout(directory: string, options: GitOptions = {}): boolean {
  if (!directoryExists(directory)) return false;

  const runner = options.runner ?? runGit;
  const result = runner(["rev-parse", "--show-toplevel"], { cwd: directory });
  if (result.status !== 0) return false;

  return samePath(result.stdout, directory);
}

/**
 * The URL of a checkout's `origin` remote, or undefined when it has none (a
 * repository created locally with `git init` has no remote until one is added).
 *
 * @param directory - The checkout to inspect.
 * @param options - The git runner to use.
 */
export function remoteUrlOf(directory: string, options: GitOptions = {}): string | undefined {
  const runner = options.runner ?? runGit;
  const result = runner(["remote", "get-url", "origin"], { cwd: directory });
  if (result.status !== 0 || result.stdout.length === 0) return undefined;
  return result.stdout;
}

/** What a clone actually did. */
export type CloneResult = {
  /** The depth git was finally asked for; 0 means the full history. */
  depth: number;
  /** True when a shallow clone was refused and the full history was fetched instead. */
  fellBackToFullClone: boolean;
};

/**
 * Clones a repository into a directory that does not yet exist, creating its
 * parents. A shallow clone is the default for a link, because a linked checkout
 * exists to be read and edited, not to carry the project's whole history; pass
 * `depth: 0` to ask for the full history outright.
 *
 * Not every remote will serve a shallow clone (`file://` transports and some
 * servers refuse one), so a failed shallow attempt is retried in full rather
 * than reported as a failure. The result says whether that happened, so the
 * caller can tell the user why the clone took longer than they expected.
 *
 * @param url - Where the repository lives.
 * @param destDir - Absolute path the working copy is created at.
 * @param options - Clone depth and the git runner to use.
 */
export function cloneRepo(
  url: string,
  destDir: string,
  options: GitOptions & { depth?: number } = {}
): CloneResult {
  if (fs.existsSync(destDir) && !isEmptyDirectory(destDir)) {
    throw new ConfigError(
      `Cannot clone into ${destDir}: the directory already exists and is not empty.\n` +
        `  Move or delete it, or link the checkout that is already there by passing ` +
        `its path to 'sous repo link'.`
    );
  }

  fs.mkdirSync(path.dirname(destDir), { recursive: true });

  const depth = options.depth ?? 1;
  const runner = options.runner ?? runGit;

  if (depth > 0) {
    const shallow = runner(["clone", "--depth", String(depth), "--", url, destDir], {});
    if (shallow.status === 0) return { depth, fellBackToFullClone: false };
    // git leaves the destination behind on some failures; clear it so the retry
    // is not refused by its own leftovers.
    fs.rmSync(destDir, { recursive: true, force: true });
  }

  runGitOrThrow(["clone", "--", url, destDir], {
    runner: options.runner,
    what: `Cloning ${url}`,
  });

  return { depth: 0, fellBackToFullClone: depth > 0 };
}

/**
 * True when two remote URLs name the same repository, ignoring the differences
 * that never change what is fetched: a `.git` suffix, a trailing slash, the
 * host's letter case, and SCP-style syntax (`git@host:owner/repo`) against URL
 * syntax (`https://host/owner/repo`).
 *
 * @param a - One remote URL.
 * @param b - The other remote URL.
 */
export function sameRemote(a: string, b: string): boolean {
  return normalizeRemoteUrl(a) === normalizeRemoteUrl(b);
}

/**
 * Reduces a remote URL to `host/path` in lower case, with any `.git` suffix,
 * trailing slash, scheme, port and user info removed, so two spellings of one
 * repository compare equal.
 *
 * @param url - The remote URL to normalize.
 */
export function normalizeRemoteUrl(url: string): string {
  let value = url.trim();

  // SCP-style syntax, which is not a URL: git@github.com:sous-io/sous.git
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(value);
  if (scp !== null) {
    value = `${scp[1]}/${scp[2]}`;
  } else {
    value = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
    // Strip user info (user@ or user:password@) from an authority.
    value = value.replace(/^[^/]*@/, "");
    // Strip a port from the host.
    value = value.replace(/^([^/]+):\d+/, "$1");
  }

  value = value.replace(/\/+$/, "");
  value = value.replace(/\.git$/i, "");
  return value.toLowerCase();
}

/** A repository's owner and name, as taken from its URL. */
export type RepoSlug = {
  /** The owning user or organization, or "repos" when the URL has no owner segment. */
  owner: string;
  /** The repository's own name, with any `.git` suffix removed. */
  name: string;
};

/**
 * Splits a remote URL into the owner and name that decide where a default clone
 * lands (`.sous/repos/<owner>/<name>`). A URL with no owner segment yields the
 * literal owner "repos", so the layout stays two levels deep whatever the URL
 * looked like.
 *
 * @param url - The remote URL to read.
 */
export function repoSlugFromUrl(url: string): RepoSlug {
  const normalized = normalizeRemoteUrl(url);
  const segments = normalized.split("/").filter((segment) => segment.length > 0);

  if (segments.length < 2) {
    throw new ConfigError(
      `Could not work out an owner and a repository name from the URL '${url}'.\n` +
        `  A repository URL looks like 'https://github.com/sous-io/sous-recipes'. ` +
        `Pass a path to 'sous repo link' to link a checkout that is already on disk.`
    );
  }

  const name = segments[segments.length - 1]!;
  const owner = segments.length >= 3 ? segments[segments.length - 2]! : "repos";
  return { owner: sanitizeSegment(owner), name: sanitizeSegment(name) };
}

/**
 * The short name a repository is known by when its URL was given on the command
 * line rather than configured: the last segment of the URL, with any `.git`
 * suffix removed.
 *
 * @param url - The remote URL to read.
 */
export function repoNameFromUrl(url: string): string {
  return repoSlugFromUrl(url).name;
}

/**
 * True when the string looks like something git can clone rather than a short
 * name: an explicit scheme, SCP-style syntax, or an absolute path.
 *
 * @param value - The string to test.
 */
export function looksLikeRepoUrl(value: string): boolean {
  if (value.includes("://")) return true;
  if (/^[^@/\s]+@[^/\s:]+:/.test(value)) return true;
  return value.startsWith("/") || value.startsWith("./") || value.startsWith("../");
}

// --- Small filesystem helpers -------------------------------------------------------------------

/** Replaces anything outside a safe path segment, so a URL can never escape the store. */
function sanitizeSegment(segment: string): string {
  const cleaned = segment.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^\.+/, "");
  return cleaned.length > 0 ? cleaned : "repo";
}

/** True when the path exists and is a directory. */
function directoryExists(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** True when the path is a directory holding nothing at all. */
function isEmptyDirectory(candidate: string): boolean {
  try {
    return fs.readdirSync(candidate).length === 0;
  } catch {
    return false;
  }
}

/** Compares two paths after resolving them, so a trailing slash never matters. */
function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}
