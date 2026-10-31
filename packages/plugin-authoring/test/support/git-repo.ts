/**
 * Real git repositories in temporary directories, for tests that need what git really does with
 * tags, worktrees and remotes.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A temporary directory and how to remove it. */
export interface TmpDir {
    path: string;
    cleanup: () => void;
}

/** Makes a temporary directory. */
export function makeTmpDir(prefix = "sous-authoring-"): TmpDir {
    const dirPath = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

    return { path: dirPath, cleanup: () => fs.rmSync(dirPath, { recursive: true, force: true }) };
}

/** The environment every test git command runs with: a fixed identity, no prompts. */
export const GIT_ENV: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Sous Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Sous Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
};

/** Runs git, throwing on failure; returns trimmed standard output. */
export function git(cwd: string, ...args: string[]): string {
    const result = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });

    if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr || result.stdout}`);
    }

    return (result.stdout ?? "").trim();
}

/** A new repository on `main`, with an identity and no signing. */
export function initRepo(dir: string): void {
    git(dir, "init", "--quiet", "--initial-branch", "main");
    git(dir, "config", "user.name", "Sous Test");
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "commit.gpgsign", "false");
    git(dir, "config", "tag.gpgsign", "false");
}

/** Writes a file, making its directories. */
export function writeFile(dir: string, relativePath: string, contents: string): void {
    const target = path.join(dir, relativePath);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents, "utf8");
}

/** Stages everything and commits it. */
export function commitAll(dir: string, message: string): void {
    git(dir, "add", "--all");
    git(dir, "commit", "--quiet", "--message", message);
}
