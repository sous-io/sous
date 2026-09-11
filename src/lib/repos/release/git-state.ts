/**
 * What git says about the working tree a release or a submission is standing in.
 *
 * Both `sous repo release --tag` and `sous repo submit` need the same handful of
 * facts before they are allowed to do anything: is anything uncommitted, which
 * branch is checked out, which branch is the default one, and where does
 * `origin` point. Sous never commits on the author's behalf, so these are read
 * to refuse politely, not to fix anything.
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
 * True when a path is tracked by git and identical to what HEAD holds. This is
 * how `--tag` confirms the index that is about to be published is the index that
 * was actually committed.
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
 * Stages exactly the given paths and commits them.
 *
 * This is the one place sous commits on an author's behalf, and it is
 * deliberately narrow: a release writes version bumps and an index, and those
 * are the only paths it stages. Anything else in the working tree is left
 * exactly as it was.
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

/**
 * Pushes one branch to a remote, setting it as the branch's upstream.
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
): Promise<void> {
  await runGit(["push", "--set-upstream", remote, branch], {
    cwd: rootDir,
    run: options.run,
  });
}

/**
 * The subject line of the most recent commit, or undefined when there is none.
 * It is the default title for a proposed change, which is what a contributor
 * would have typed anyway.
 *
 * @param rootDir - The repository's root directory.
 * @param options - The command runner to use.
 */
export async function lastCommitSubject(
  rootDir: string,
  options: RunOptions = {}
): Promise<string | undefined> {
  try {
    const subject = await runGit(["log", "-1", "--format=%s"], {
      cwd: rootDir,
      run: options.run,
    });
    return subject.length > 0 ? subject : undefined;
  } catch {
    return undefined;
  }
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
