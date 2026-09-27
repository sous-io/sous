/**
 * What git says about the working tree a release or a submission is standing in.
 *
 * Both `sous repo release` and `sous repo submit` need the same handful of
 * facts before they are allowed to do anything: is anything uncommitted, which
 * branch is checked out, which branch is the default one, and where does
 * `origin` point. A release makes exactly one commit of its own (its version
 * bumps and its index, through `commitPaths`) and refuses while anything else
 * is uncommitted; a submission commits only when `--commit` asks it to
 * (`commitEverything`). Everything else here is read to refuse politely rather
 * than to fix anything.
 *
 * Every function takes the injectable command runner, so tests never spawn git
 * unless they mean to.
 */

import { runGit, type RunOptions } from "../providers/git.js";

/** One path git reports as changed, with the two-letter status it reported. */
export type ChangedPath = {
  /** The status code from `git status --porcelain`, such as `M `, `??` or `A `. */
  status: string;
  /** The path, relative to the repository root. */
  path: string;
};

/**
 * Everything `git status --porcelain` reports: staged changes, unstaged changes
 * and untracked files alike. An empty list means the working tree is clean.
 *
 * @param rootDir - The repository's root directory.
 * @param options - The command runner to use.
 */
export async function uncommittedChanges(
  rootDir: string,
  options: RunOptions = {}
): Promise<ChangedPath[]> {
  const output = await runGit(["status", "--porcelain"], {
    cwd: rootDir,
    run: options.run,
  });
  if (output.length === 0) return [];

  const changed: ChangedPath[] = [];
  for (const line of output.split("\n")) {
    // The status field is one or two characters, and the command runner trims
    // its output, so a leading space (an unstaged edit) is already gone by the
    // time the line arrives here. Split on the whitespace instead of counting
    // columns. A rename is reported as 'old -> new'; the new name is the one
    // that still exists, so that is the one reported.
    const match = /^(\S{1,2})\s+(.*)$/.exec(line.trim());
    if (match === null) continue;
    const target = match[2]!;
    const arrow = target.indexOf(" -> ");
    changed.push({
      status: match[1]!,
      path: arrow === -1 ? target : target.slice(arrow + 4),
    });
  }
  return changed;
}

/**
 * The name of the checked-out branch, or undefined when HEAD is detached (which
 * is what a CI checkout of a tag looks like).
 *
 * @param rootDir - The repository's root directory.
 * @param options - The command runner to use.
 */
export async function currentBranch(
  rootDir: string,
  options: RunOptions = {}
): Promise<string | undefined> {
  try {
    const name = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: rootDir,
      run: options.run,
    });
    return name === "HEAD" ? undefined : name;
  } catch {
    return undefined;
  }
}

/**
 * The repository's default branch, taken from what `origin/HEAD` points at.
 * Returns undefined when the remote never told this clone, which is normal for
 * a repository cloned with `--depth 1` or created locally.
 *
 * @param rootDir - The repository's root directory.
 * @param options - The command runner to use.
 */
export async function defaultBranch(
  rootDir: string,
  options: RunOptions = {}
): Promise<string | undefined> {
  try {
    const ref = await runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], {
      cwd: rootDir,
      run: options.run,
    });
    const slash = ref.indexOf("/");
    return slash === -1 ? ref : ref.slice(slash + 1);
  } catch {
    return undefined;
  }
}

/**
 * The commit where this checkout's own work starts: the point HEAD shares with
 * the remote's copy of a branch. Returns undefined when this checkout holds no
 * copy of that branch, or when git cannot find a commit the two share.
 *
 * A shallow clone answers this as long as HEAD was built on the branch it was
 * cloned from, which is why a submission can rely on it where it cannot rely on
 * tags.
 *
 * @param rootDir - The repository's root directory.
 * @param remote - The remote whose branch is compared, normally `origin`.
 * @param branch - The branch on that remote, normally the default one.
 * @param options - The command runner to use.
 */
export async function forkPoint(
  rootDir: string,
  remote: string,
  branch: string,
  options: RunOptions = {}
): Promise<string | undefined> {
  try {
    const commit = await runGit(["merge-base", `refs/remotes/${remote}/${branch}`, "HEAD"], {
      cwd: rootDir,
      run: options.run,
    });
    return commit.length > 0 ? commit : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when the commits since `since` changed a path, comparing that commit
 * with HEAD.
 *
 * @param rootDir - The repository's root directory.
 * @param since - The commit to compare HEAD with.
 * @param relativePath - The path to check, relative to the repository root.
 * @param options - The command runner to use.
 */
export async function pathChangedSince(
  rootDir: string,
  since: string,
  relativePath: string,
  options: RunOptions = {}
): Promise<boolean> {
  const changed = await runGit(["diff", "--name-only", since, "HEAD", "--", relativePath], {
    cwd: rootDir,
    run: options.run,
  });
  return changed.length > 0;
}

/**
 * The URL of a remote, or undefined when the repository has no such remote.
 *
 * @param rootDir - The repository's root directory.
 * @param remote - The remote's name, normally `origin`.
 * @param options - The command runner to use.
 */
export async function remoteUrl(
  rootDir: string,
  remote: string,
  options: RunOptions = {}
): Promise<string | undefined> {
  try {
    const url = await runGit(["remote", "get-url", remote], {
      cwd: rootDir,
      run: options.run,
    });
    return url.length > 0 ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when a path is tracked by git and identical to what HEAD holds. It is how
 * a caller confirms that a file it is about to act on is the one the repository
 * actually committed.
 *
 * @param rootDir - The repository's root directory.
 * @param relativePath - The path to check, relative to the repository root.
 * @param options - The command runner to use.
 */
export async function isCommittedAndUnchanged(
  rootDir: string,
  relativePath: string,
  options: RunOptions = {}
): Promise<boolean> {
  const tracked = await runGit(["ls-files", "--", relativePath], {
    cwd: rootDir,
    run: options.run,
  });
  if (tracked.length === 0) return false;

  const changed = await runGit(["status", "--porcelain", "--", relativePath], {
    cwd: rootDir,
    run: options.run,
  });
  return changed.length === 0;
}

/**
 * True when git can work out who is committing, which is what it needs before
 * it will make a commit or an annotated tag.
 *
 * `git var GIT_AUTHOR_IDENT` answers the exact question git asks itself: it
 * honours the `user.name` and `user.email` settings, the `GIT_AUTHOR_*` and
 * `GIT_COMMITTER_*` environment variables, and the strict rules that reject a
 * guessed identity. It fails with the same "empty ident name" or "unable to
 * auto-detect email address" that a commit would have failed with, which is
 * why the check is made ahead of time rather than left to the commit.
 *
 * @param rootDir - The repository's root directory.
 * @param options - The command runner to use.
 */
export async function hasCommitIdentity(
  rootDir: string,
  options: RunOptions = {}
): Promise<boolean> {
  for (const name of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
    try {
      const ident = await runGit(["var", name], { cwd: rootDir, run: options.run });
      if (ident.length === 0) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Stages exactly the given paths and commits them.
 *
 * This is how `sous repo release` commits on an author's behalf, and it is
 * deliberately narrow: a release writes version bumps and an index, and those
 * are the only paths it stages. Anything else in the working tree is left
 * exactly as it was. The only other commit sous makes is `commitEverything`,
 * for `sous repo submit --commit`.
 *
 * @param rootDir - The repository's root directory.
 * @param paths - The paths to stage, relative to the repository root.
 * @param message - The commit message.
 * @param options - The command runner to use.
 */
export async function commitPaths(
  rootDir: string,
  paths: ReadonlyArray<string>,
  message: string,
  options: RunOptions = {}
): Promise<void> {
  if (paths.length === 0) return;
  await runGit(["add", "--", ...paths], { cwd: rootDir, run: options.run });
  await runGit(["commit", "--message", message, "--", ...paths], {
    cwd: rootDir,
    run: options.run,
  });
}

/**
 * True when any of the given paths differs from what HEAD holds, so a release
 * knows whether it has anything to commit.
 *
 * @param rootDir - The repository's root directory.
 * @param paths - The paths to check, relative to the repository root.
 * @param options - The command runner to use.
 */
export async function anythingToCommit(
  rootDir: string,
  paths: ReadonlyArray<string>,
  options: RunOptions = {}
): Promise<boolean> {
  if (paths.length === 0) return false;
  const changed = await runGit(["status", "--porcelain", "--", ...paths], {
    cwd: rootDir,
    run: options.run,
  });
  return changed.length > 0;
}

/**
 * Creates a branch at HEAD and checks it out.
 *
 * @param rootDir - The repository's root directory.
 * @param branch - The branch to create.
 * @param options - The command runner to use.
 */
export async function createBranch(
  rootDir: string,
  branch: string,
  options: RunOptions = {}
): Promise<void> {
  await runGit(["checkout", "-b", branch], { cwd: rootDir, run: options.run });
}

/** What a push did: sent new commits, or found the remote already had them. */
export type PushOutcome = "updated" | "up-to-date";

/**
 * Pushes one branch to a remote, setting it as the branch's upstream, and says
 * whether anything was sent.
 *
 * The push is never forced. When the remote branch holds commits the local one
 * lacks, git refuses, and its own explanation is what the caller receives: git
 * is the authority on whether a push is safe, so nothing here second-guesses it.
 * Whether anything was sent is read from git's machine-readable report, where a
 * ref that was already current is flagged with `=`.
 *
 * @param rootDir - The repository's root directory.
 * @param remote - The remote to push to.
 * @param branch - The branch to push.
 * @param options - The command runner to use.
 */
export async function pushBranch(
  rootDir: string,
  remote: string,
  branch: string,
  options: RunOptions = {}
): Promise<PushOutcome> {
  const report = await runGit(["push", "--porcelain", "--set-upstream", remote, branch], {
    cwd: rootDir,
    run: options.run,
  });
  return pushReportIsUpToDate(report) ? "up-to-date" : "updated";
}

/**
 * True when git's machine-readable push report says every ref it pushed was
 * already current on the remote.
 *
 * pushReportIsUpToDate("To origin\n=\trefs/heads/a:refs/heads/a\t[up to date]\nDone");
 * // -> true
 *
 * @param report - What `git push --porcelain` printed.
 */
export function pushReportIsUpToDate(report: string): boolean {
  const refLines = report.split("\n").filter((line) => /^[ +\-*!=]\t/.test(line));
  return refLines.length > 0 && refLines.every((line) => line.startsWith("=\t"));
}

/**
 * True when a local branch of that name exists.
 *
 * @param rootDir - The repository's root directory.
 * @param branch - The branch name.
 * @param options - The command runner to use.
 */
export async function branchExists(
  rootDir: string,
  branch: string,
  options: RunOptions = {}
): Promise<boolean> {
  try {
    await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: rootDir,
      run: options.run,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks out an existing branch. Git refuses when uncommitted changes would be
 * overwritten, and that refusal reaches the caller unchanged.
 *
 * @param rootDir - The repository's root directory.
 * @param branch - The branch to check out.
 * @param options - The command runner to use.
 */
export async function switchBranch(
  rootDir: string,
  branch: string,
  options: RunOptions = {}
): Promise<void> {
  await runGit(["switch", branch], { cwd: rootDir, run: options.run });
}

/**
 * Every path the commits since `since` changed, comparing that commit with HEAD.
 *
 * @param rootDir - The repository's root directory.
 * @param since - The commit to compare HEAD with.
 * @param options - The command runner to use.
 */
export async function pathsChangedSince(
  rootDir: string,
  since: string,
  options: RunOptions = {}
): Promise<string[]> {
  const changed = await runGit(["diff", "--name-only", since, "HEAD"], {
    cwd: rootDir,
    run: options.run,
  });
  return changed.length === 0 ? [] : changed.split("\n").filter((line) => line.length > 0);
}

/**
 * Stages everything the working tree holds (edits, deletions and untracked
 * files alike) and commits it with the given message.
 *
 * This is the second place sous commits on an author's behalf, and it runs only
 * for `sous repo submit --commit`, after the contributor has seen every path it
 * stages and agreed to it.
 *
 * @param rootDir - The repository's root directory.
 * @param message - The commit message.
 * @param options - The command runner to use.
 */
export async function commitEverything(
  rootDir: string,
  message: string,
  options: RunOptions = {}
): Promise<void> {
  await runGit(["add", "--all"], { cwd: rootDir, run: options.run });
  await runGit(["commit", "--quiet", "--message", message], {
    cwd: rootDir,
    run: options.run,
  });
}

/**
 * The branch name sous proposes for a submission, stamped with the minute it
 * was made so two submissions from one checkout never collide.
 *
 * @param now - The moment the branch is being created.
 */
export function submitBranchName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `sous/submit-${stamp}`;
}
