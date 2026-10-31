import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * A tiny real git repository, for tests that need git to actually be git:
 * tags, worktrees, commit dates and `status --porcelain` all behave in ways no
 * mock reproduces faithfully. Nothing here reaches a network; every repository
 * is created locally with `git init`.
 */

/** Runs a git command in a directory, throwing with git's own output on failure. */
export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Sous Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Sous Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.stdout}`
    );
  }
  return (result.stdout ?? "").trim();
}

/**
 * Creates a git repository in a directory that already exists, with the default
 * branch named `main` and an identity configured, so commits do not depend on
 * whatever the machine running the tests has in its global git config.
 *
 * @param dir - The directory to turn into a repository.
 */
export function initRepo(dir: string): void {
  git(dir, "init", "--quiet", "--initial-branch", "main");
  git(dir, "config", "user.name", "Sous Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "tag.gpgsign", "false");
}

/** Writes a file inside a repository, creating the directories above it. */
export function writeFile(dir: string, relativePath: string, contents: string): void {
  const target = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, "utf8");
}

/** Stages everything and makes a commit. */
export function commitAll(dir: string, message: string): void {
  git(dir, "add", "--all");
  git(dir, "commit", "--quiet", "--message", message);
}
