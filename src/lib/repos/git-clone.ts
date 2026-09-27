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

/** Where and for how long one git command may run. */
export type GitRunOptions = {
  /** The directory git runs in. */
  cwd?: string;
  /**
   * How long git may run, in milliseconds, before it is stopped. A command that
   * runs out of time comes back with a null status and a sentence saying so in
   * `stderr`, never as an exception. Unset means no limit.
   */
  timeoutMs?: number;
};

/**
 * Runs one git command. Swappable so tests never need a real git binary.
 *
 * @param args - The arguments passed to git, without the leading "git".
 * @param options - Where to run it, and for how long.
 */
export type GitRunner = (args: string[], options: GitRunOptions) => GitResult;

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
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
  });

  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    const seconds = Math.round((options.timeoutMs ?? 0) / 1000);
    const partial = (result.stderr ?? "").trim();
    return {
      status: null,
      stdout: (result.stdout ?? "").trim(),
      stderr:
        `git did not finish within ${seconds} seconds and was stopped.` +
        (partial.length > 0 ? `\n${partial}` : ""),
    };
  }

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

/**
 * Runs git and throws a ConfigError on failure: a first line naming the step
 * that failed, then the command, then git's own message, line for line. Git is
 * the authority on what it will and will not do to a checkout, so its refusal
 * is passed through rather than paraphrased.
 */
function runGitOrThrow(
  args: string[],
  options: { cwd?: string; runner?: GitRunner; what: string; timeoutMs?: number }
): GitResult {
  const runner = options.runner ?? runGit;
  const result = runner(args, { cwd: options.cwd, timeoutMs: options.timeoutMs });
  if (result.status !== 0) {
    const detail = gitMessage(result);
    const said =
      detail.length > 0
        ? `  git said:\n${detail
            .split("\n")
            .map((line) => `    ${line}`)
            .join("\n")}\n`
        : "";
    throw new ConfigError(
      `${options.what} failed.\n` +
        `  Command: git ${args.join(" ")}\n` +
        said +
        `  Fix the problem git reported, then run the command again.`
    );
  }
  return result;
}

/** What git said about a result: its error output, or its standard output when that is all. */
function gitMessage(result: GitResult): string {
  return result.stderr.length > 0 ? result.stderr : result.stdout;
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

// --- Branches and upstream ----------------------------------------------------------------------
//
// Everything below works on the `origin` remote, which is the one a clone
// creates and the one `remoteUrlOf` reads. Each function either reports a fact
// or runs exactly one git operation; when git refuses an operation, its own
// message is passed through under a line naming the step, and nothing here
// second-guesses it. The one exception is `discardableWork`, which exists
// because making a branch match upstream discards work without git warning
// about it.

/** The remote every function here reads from and fetches. */
export const UPSTREAM_REMOTE = "origin";

/**
 * How long the fetch behind the divergence report may take, in milliseconds.
 * It is tight on purpose: the report is a courtesy, and an unreachable host
 * must fall back to a warning rather than hold the link up.
 */
export const UPSTREAM_CHECK_TIMEOUT_MS = 10_000;

/** What a fetch that is allowed to fail produced. */
export type FetchOutcome =
  | { ok: true }
  | {
      ok: false;
      /** Git's own explanation, or the sentence saying it ran out of time. */
      reason: string;
    };

/**
 * The branch a checkout has checked out, or undefined when HEAD is detached
 * (a tag or a bare commit is checked out instead of a branch).
 *
 * @param directory - The checkout to inspect.
 * @param options - The git runner to use.
 */
export function currentBranch(directory: string, options: GitOptions = {}): string | undefined {
  const runner = options.runner ?? runGit;
  const result = runner(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: directory });
  if (result.status !== 0 || result.stdout.length === 0) return undefined;
  return result.stdout;
}

/**
 * The abbreviated commit HEAD points at, for describing a detached checkout.
 *
 * @param directory - The checkout to inspect.
 * @param options - The git runner to use.
 */
export function headCommit(directory: string, options: GitOptions = {}): string | undefined {
  const runner = options.runner ?? runGit;
  const result = runner(["rev-parse", "--short", "HEAD"], { cwd: directory });
  if (result.status !== 0 || result.stdout.length === 0) return undefined;
  return result.stdout;
}

/**
 * The upstream repository's default branch, or undefined when it cannot be
 * worked out. A clone records it as `origin/HEAD`, which is read first and
 * needs no network; a checkout that lacks that record (one made with `git
 * init` and a remote added later, say) is asked about over the network, under
 * the same tight timeout as the upstream check.
 *
 * @param directory - The checkout to inspect.
 * @param options - The git runner to use.
 */
export function defaultBranch(directory: string, options: GitOptions = {}): string | undefined {
  const runner = options.runner ?? runGit;
  const prefix = `${UPSTREAM_REMOTE}/`;

  const local = runner(
    ["symbolic-ref", "--quiet", "--short", `refs/remotes/${UPSTREAM_REMOTE}/HEAD`],
    { cwd: directory }
  );
  if (local.status === 0 && local.stdout.startsWith(prefix)) {
    return local.stdout.slice(prefix.length);
  }

  const remote = runner(["ls-remote", "--symref", UPSTREAM_REMOTE, "HEAD"], {
    cwd: directory,
    timeoutMs: UPSTREAM_CHECK_TIMEOUT_MS,
  });
  if (remote.status !== 0) return undefined;
  const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(remote.stdout);
  return match?.[1];
}

/**
 * Fetches from upstream, allowing the fetch to fail. A fetch updates only the
 * remote-tracking refs, never the user's files or branches, which is why the
 * divergence report may run one unasked.
 *
 * @param directory - The checkout to fetch into.
 * @param options - The git runner to use, and how long the fetch may take.
 */
export function tryFetchUpstream(
  directory: string,
  options: GitOptions & { timeoutMs?: number } = {}
): FetchOutcome {
  const runner = options.runner ?? runGit;
  const result = runner(["fetch", "--quiet", UPSTREAM_REMOTE], {
    cwd: directory,
    timeoutMs: options.timeoutMs ?? UPSTREAM_CHECK_TIMEOUT_MS,
  });
  if (result.status === 0) return { ok: true };
  const reason = gitMessage(result);
  return {
    ok: false,
    reason: reason.length > 0 ? reason : `git exited with status ${String(result.status)}`,
  };
}

/**
 * When this checkout last heard from upstream, as far as it recorded: the
 * newer of the last fetch and the last update to the default branch's
 * remote-tracking ref (a clone writes the second and not the first).
 * Undefined when neither record exists.
 *
 * @param directory - The checkout to inspect.
 * @param branch - The upstream default branch, when it is known.
 * @param options - The git runner to use.
 */
export function lastFetchedAt(
  directory: string,
  branch: string | undefined,
  options: GitOptions = {}
): Date | undefined {
  const runner = options.runner ?? runGit;
  const records = ["FETCH_HEAD"];
  if (branch !== undefined) records.push(`logs/refs/remotes/${UPSTREAM_REMOTE}/${branch}`);

  let newest: Date | undefined;
  for (const record of records) {
    const located = runner(["rev-parse", "--git-path", record], { cwd: directory });
    if (located.status !== 0 || located.stdout.length === 0) continue;
    const file = path.resolve(directory, located.stdout);
    try {
      const modified = fs.statSync(file).mtime;
      if (newest === undefined || modified > newest) newest = modified;
    } catch {
      // No such record; the other one may still exist.
    }
  }
  return newest;
}

/** How a checkout's current state compares with upstream's default branch. */
export type UpstreamComparison = {
  /** The branch checked out, or undefined when HEAD is detached. */
  branch: string | undefined;
  /** The commit HEAD points at, abbreviated. */
  commit: string | undefined;
  /** The upstream default branch compared against. */
  defaultBranch: string;
  /**
   * True when every commit on HEAD is already on the upstream default branch;
   * undefined when git could not tell (the remote-tracking ref is missing).
   */
  merged: boolean | undefined;
  /** Commits on the upstream default branch that HEAD lacks; undefined when git could not tell. */
  behind: number | undefined;
};

/**
 * Compares a checkout's HEAD with the upstream default branch, from the
 * remote-tracking refs as they stand. It runs no fetch of its own.
 *
 * @param directory - The checkout to inspect.
 * @param branch - The upstream default branch.
 * @param options - The git runner to use.
 */
export function compareWithUpstream(
  directory: string,
  branch: string,
  options: GitOptions = {}
): UpstreamComparison {
  const runner = options.runner ?? runGit;
  const upstream = `${UPSTREAM_REMOTE}/${branch}`;

  const ancestor = runner(["merge-base", "--is-ancestor", "HEAD", upstream], {
    cwd: directory,
  });
  const merged = ancestor.status === 0 ? true : ancestor.status === 1 ? false : undefined;

  const count = runner(["rev-list", "--count", `HEAD..${upstream}`], { cwd: directory });
  const parsed = Number.parseInt(count.stdout, 10);
  const behind = count.status === 0 && Number.isFinite(parsed) ? parsed : undefined;

  return {
    branch: currentBranch(directory, options),
    commit: headCommit(directory, options),
    defaultBranch: branch,
    merged,
    behind,
  };
}

/**
 * Asks git whether a name is a valid branch name, and passes its refusal
 * through when it is not. Every name the user types goes through this before
 * it reaches any other git command, which is also what stops a name that starts
 * with a dash from being read as an option.
 *
 * @param directory - The checkout the name is for.
 * @param name - The branch name as the user typed it.
 * @param options - The git runner to use.
 */
export function assertBranchName(directory: string, name: string, options: GitOptions = {}): void {
  runGitOrThrow(["check-ref-format", "--branch", name], {
    cwd: directory,
    runner: options.runner,
    what: `Checking the branch name '${name}'`,
  });
}

/**
 * True when the checkout has a local branch of that name.
 *
 * @param directory - The checkout to inspect.
 * @param name - The branch name.
 * @param options - The git runner to use.
 */
export function localBranchExists(
  directory: string,
  name: string,
  options: GitOptions = {}
): boolean {
  const runner = options.runner ?? runGit;
  const result = runner(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], {
    cwd: directory,
  });
  return result.status === 0;
}

/**
 * Fetches one named branch from upstream into its remote-tracking ref.
 *
 * A clone sous makes is single-branch, so its fetch configuration covers only
 * the default branch, and neither a plain fetch nor `git switch` would ever see
 * another one. The branch is therefore fetched by an explicit refspec, and then
 * added to the remote's fetch list (`git remote set-branches --add`), so later
 * fetches keep it current and `git switch` can find it. A checkout whose fetch
 * configuration already covers the branch is left as it is.
 *
 * @param directory - The checkout to fetch into.
 * @param name - The branch to fetch.
 * @param options - The git runner to use.
 */
export function fetchBranch(directory: string, name: string, options: GitOptions = {}): void {
  runGitOrThrow(
    [
      "fetch",
      "--quiet",
      UPSTREAM_REMOTE,
      `+refs/heads/${name}:refs/remotes/${UPSTREAM_REMOTE}/${name}`,
    ],
    {
      cwd: directory,
      runner: options.runner,
      what: `Fetching the branch '${name}' from ${UPSTREAM_REMOTE}`,
    }
  );

  if (fetchConfigCovers(directory, name, options)) return;

  runGitOrThrow(["remote", "set-branches", "--add", UPSTREAM_REMOTE, name], {
    cwd: directory,
    runner: options.runner,
    what: `Adding the branch '${name}' to the branches ${UPSTREAM_REMOTE} is fetched for`,
  });
}

/**
 * True when the remote's configured fetch refspecs already bring the branch
 * in: a wildcard over every branch, or the branch by name.
 */
function fetchConfigCovers(directory: string, name: string, options: GitOptions): boolean {
  const runner = options.runner ?? runGit;
  const result = runner(["config", "--get-all", `remote.${UPSTREAM_REMOTE}.fetch`], {
    cwd: directory,
  });
  if (result.status !== 0) return false;
  return result.stdout.split("\n").some((line) => {
    const source = line.trim().replace(/^\+/, "").split(":")[0];
    return source === "refs/heads/*" || source === `refs/heads/${name}`;
  });
}

/**
 * Switches the checkout to an existing branch with `git switch`, which also
 * creates a local branch tracking an upstream one of the same name.
 *
 * @param directory - The checkout to switch.
 * @param name - The branch to switch to.
 * @param options - The git runner to use.
 */
export function switchBranch(directory: string, name: string, options: GitOptions = {}): void {
  runGitOrThrow(["switch", name], {
    cwd: directory,
    runner: options.runner,
    what: `Switching to the branch '${name}'`,
  });
}

/**
 * Creates a branch at a start point and switches to it, with `git switch
 * --create`, which refuses a branch that already exists. The new branch tracks
 * nothing, so pushing it never lands on the branch it started from.
 *
 * @param directory - The checkout to work in.
 * @param name - The branch to create.
 * @param startPoint - Where it starts, such as `origin/main`.
 * @param options - The git runner to use.
 */
export function createBranch(
  directory: string,
  name: string,
  startPoint: string,
  options: GitOptions = {}
): void {
  runGitOrThrow(["switch", "--create", name, "--no-track", startPoint], {
    cwd: directory,
    runner: options.runner,
    what: `Creating the branch '${name}' from ${startPoint}`,
  });
}

/** The local work that making a branch match upstream would throw away. */
export type DiscardableWork = {
  /** Changes to tracked files that are not committed, in `git status --short` form. */
  uncommitted: string[];
  /** Commits on the local branch that its upstream counterpart lacks, one line each. */
  localCommits: string[];
};

/**
 * Lists what `resetBranchToUpstream` would discard: uncommitted changes to
 * tracked files (untracked files are left alone by it, so they are not listed),
 * and commits on the local branch that the fetched upstream branch lacks. Run
 * it after fetching the branch.
 *
 * @param directory - The checkout to inspect.
 * @param name - The branch that would be made to match upstream.
 * @param options - The git runner to use.
 */
export function discardableWork(
  directory: string,
  name: string,
  options: GitOptions = {}
): DiscardableWork {
  const status = runGitOrThrow(["status", "--porcelain", "--untracked-files=no"], {
    cwd: directory,
    runner: options.runner,
    what: "Listing the uncommitted changes",
  });
  const uncommitted = status.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);

  let localCommits: string[] = [];
  if (localBranchExists(directory, name, options)) {
    const log = runGitOrThrow(
      ["log", "--oneline", "--no-decorate", `refs/remotes/${UPSTREAM_REMOTE}/${name}..refs/heads/${name}`],
      {
        cwd: directory,
        runner: options.runner,
        what: `Listing the commits on '${name}' that ${UPSTREAM_REMOTE} does not have`,
      }
    );
    localCommits = log.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  return { uncommitted, localCommits };
}

/**
 * Switches to a branch and makes it match its fetched upstream counterpart
 * exactly, creating the local branch when there is none. Uncommitted changes to
 * tracked files and local commits upstream lacks are discarded, which is why a
 * caller lists them with `discardableWork` and asks first. Every other branch
 * is left as it is.
 *
 * @param directory - The checkout to work in.
 * @param name - The branch to update.
 * @param options - The git runner to use.
 */
export function resetBranchToUpstream(
  directory: string,
  name: string,
  options: GitOptions = {}
): void {
  runGitOrThrow(
    ["switch", "--discard-changes", "--force-create", name, `${UPSTREAM_REMOTE}/${name}`],
    {
      cwd: directory,
      runner: options.runner,
      what: `Making the branch '${name}' match ${UPSTREAM_REMOTE}/${name}`,
    }
  );
}

/**
 * The name `--generate-branch` gives a new branch: `sous/edit-<YYYYMMDD>-<HHMM>`,
 * in local time.
 *
 * @param now - The moment to name it after. Defaults to now.
 */
export function generatedBranchName(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `sous/edit-${date}-${time}`;
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
