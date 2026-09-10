/**
 * The one place the Repositories layer shells out.
 *
 * Every subprocess a provider runs (git itself, and the `gh` / `glab` CLIs when
 * they are present and can hand over a token) goes through the helpers here, so
 * failures are reported the same way everywhere: the command that was run, the
 * exit code it returned, and whatever it wrote to stderr.
 *
 * The runner is injectable. Tests substitute their own, so no test in this
 * layer ever spawns a process or touches the network.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "../../errors.js";

/** What a finished subprocess reports back. */
export type CommandResult = {
  /** The process exit code; 0 on success. */
  code: number;
  stdout: string;
  stderr: string;
};

/** How a command is run. Tests replace this with a function of their own. */
export type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd?: string }
) => Promise<CommandResult>;

/**
 * The default runner: spawns the command, captures both streams, and resolves
 * once it exits. A command that cannot be started at all (it is not installed)
 * resolves with exit code 127, so callers treat it as an ordinary failure.
 *
 * @param command - The executable to run.
 * @param args - Its arguments, already split.
 * @param options - Optional working directory.
 */
export const spawnCommand: CommandRunner = (command, args, options = {}) =>
  new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error: Error) => {
      resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

/** Options shared by every subprocess helper here. */
export type RunOptions = {
  /** Directory to run in. */
  cwd?: string;
  /** The runner to use. Defaults to spawning a real process. */
  run?: CommandRunner;
};

/** Renders a command and its arguments the way a user would have typed them. */
function describeCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

/**
 * Runs `git` with the given arguments and returns its standard output, trimmed.
 * A non-zero exit is a ConfigError naming the command, the exit code and the
 * error output, because that is what a user needs in order to fix it.
 *
 * @param args - Arguments to pass to git.
 * @param options - Working directory and an optional runner override.
 */
export async function runGit(args: string[], options: RunOptions = {}): Promise<string> {
  const run = options.run ?? spawnCommand;
  const result = await run("git", args, { cwd: options.cwd });

  if (result.code !== 0) {
    const lines = [
      `The command '${describeCommand("git", args)}' failed with exit code ${result.code}.`,
    ];
    if (options.cwd !== undefined) lines.push(`  It was run in ${options.cwd}.`);
    const detail = result.stderr.trim() || result.stdout.trim();
    if (detail.length > 0) {
      for (const line of detail.split("\n")) lines.push(`  ${line}`);
    }
    if (result.code === 127) {
      lines.push(
        "  Sous fetches recipes with git, so git must be installed and on your PATH."
      );
    }
    throw new ConfigError(lines.join("\n"));
  }

  return result.stdout.trim();
}

/**
 * Runs a command that sous can do without, returning its trimmed output or
 * undefined when it is missing, unauthenticated, or otherwise unhappy. Used for
 * the optional `gh auth token` and `glab auth token` lookups: a missing CLI is
 * never a reason to fail.
 *
 * @param command - The executable to try.
 * @param args - Its arguments.
 * @param options - Working directory and an optional runner override.
 */
export async function tryCommand(
  command: string,
  args: string[],
  options: RunOptions = {}
): Promise<string | undefined> {
  const run = options.run ?? spawnCommand;
  try {
    const result = await run(command, args, { cwd: options.cwd });
    if (result.code !== 0) return undefined;
    const output = result.stdout.trim();
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fetches ONE subtree of a repository at one tag, and nothing else.
 *
 * A shallow, blobless, sparse checkout is what makes this cheap: git downloads
 * the commit at the tag, then only the blobs inside the recipe folder. Sous
 * never copies a whole repository in order to install one recipe.
 *
 * The temporary checkout is made beside the destination rather than in the
 * system temporary directory, so moving the subtree into place is a rename on
 * one filesystem; a cross-device move still works, it just copies.
 *
 * @param options - The clone URL, the tag, the subtree and where it should land.
 */
export async function fetchSubtree(options: {
  /** The repository's HTTPS clone URL. */
  cloneUrl: string;
  /** The git tag to fetch. */
  tag: string;
  /** The subtree's path, relative to the repository root. */
  subPath: string;
  /** Where the subtree's contents should end up. */
  destDir: string;
  /** How subprocesses are run. Defaults to spawning a real process. */
  run?: CommandRunner;
}): Promise<void> {
  const { cloneUrl, tag, subPath, destDir } = options;
  const parent = path.dirname(destDir);
  await fs.mkdir(parent, { recursive: true });

  const workDir = await fs.mkdtemp(path.join(parent, ".sous-fetch-"));
  const checkoutDir = path.join(workDir, "checkout");

  try {
    await runGit(
      [
        "clone",
        "--depth",
        "1",
        "--filter=blob:none",
        "--sparse",
        "--branch",
        tag,
        cloneUrl,
        checkoutDir,
      ],
      { run: options.run }
    );
    await runGit(["sparse-checkout", "set", subPath], {
      cwd: checkoutDir,
      run: options.run,
    });

    const source = path.join(checkoutDir, subPath);
    if (!(await isDirectory(source))) {
      throw new ConfigError(
        `The repository ${cloneUrl} has no folder '${subPath}' at the tag '${tag}'.\n` +
          `  The repository's index says the recipe lives there, so either the index is ` +
          `out of date or the tag points at the wrong commit.`
      );
    }

    await fs.rm(destDir, { recursive: true, force: true });
    await movePath(source, destDir);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

/** True when the path exists and is a directory. */
async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Moves a directory, falling back to a recursive copy when the source and the
 * destination live on different filesystems.
 *
 * @param source - The directory to move.
 * @param destination - Where it should end up.
 */
async function movePath(source: string, destination: string): Promise<void> {
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await fs.cp(source, destination, { recursive: true });
    await fs.rm(source, { recursive: true, force: true });
  }
}
