/**
 * Unit tests for the subprocess helpers the providers share. No test here
 * spawns a real process: every one passes its own runner.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fetchSubtree, runGit, tryCommand, type CommandRunner } from "./git.js";
import { isConfigError } from "../../errors.js";
import { makeTmpDir } from "../../../test/utils/tmp.js";

/** Builds a runner that answers every call with the same result. */
function fixedRunner(result: { code: number; stdout?: string; stderr?: string }): CommandRunner {
  return async () => ({ code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
}

describe("runGit()", () => {
  /**
   * runGit should hand back the command's standard output with surrounding
   * whitespace removed.
   *
   * runGit(["rev-parse", "HEAD"], { run }) // -> "abc123"
   */
  it("should return the trimmed standard output on success", async () => {
    const output = await runGit(["rev-parse", "HEAD"], {
      run: fixedRunner({ code: 0, stdout: "abc123\n" }),
    });
    expect(output).toBe("abc123");
  });

  /**
   * runGit should raise a ConfigError naming the command, the exit code and the
   * error output, because those three facts are what a user needs to fix it.
   */
  it("should raise a ConfigError naming the command, the code and stderr", async () => {
    const promise = runGit(["clone", "--branch", "v1.0.0", "https://example.com/x.git"], {
      run: fixedRunner({ code: 128, stderr: "fatal: Remote branch v1.0.0 not found" }),
    });

    await expect(promise).rejects.toThrow(/exit code 128/);
    await promise.catch((error: unknown) => {
      expect(isConfigError(error)).toBe(true);
      expect((error as Error).message).toContain("git clone --branch v1.0.0");
      expect((error as Error).message).toContain("Remote branch v1.0.0 not found");
    });
  });

  /**
   * An exit code of 127 means the command could not be started at all, so the
   * message should say that git has to be installed.
   */
  it("should explain that git must be installed when the command is missing", async () => {
    const promise = runGit(["--version"], { run: fixedRunner({ code: 127, stderr: "ENOENT" }) });
    await expect(promise).rejects.toThrow(/git must be installed/);
  });
});

describe("tryCommand()", () => {
  /**
   * tryCommand should return trimmed output when the command succeeds.
   *
   * tryCommand("gh", ["auth", "token"], { run }) // -> "gho_token"
   */
  it("should return the command's output when it succeeds", async () => {
    const value = await tryCommand("gh", ["auth", "token"], {
      run: fixedRunner({ code: 0, stdout: "gho_token\n" }),
    });
    expect(value).toBe("gho_token");
  });

  /**
   * A missing or unhappy optional command is never an error: tryCommand should
   * return undefined so the caller carries on without a token.
   */
  it("should return undefined when the command fails or is missing", async () => {
    expect(await tryCommand("gh", ["auth", "token"], { run: fixedRunner({ code: 127 }) })).toBeUndefined();
    expect(await tryCommand("gh", ["auth", "token"], { run: fixedRunner({ code: 1 }) })).toBeUndefined();
    expect(
      await tryCommand("gh", ["auth", "token"], { run: fixedRunner({ code: 0, stdout: "  \n" }) })
    ).toBeUndefined();
  });
});

describe("fetchSubtree()", () => {
  /**
   * fetchSubtree should shallow, blobless, sparse checkout ONE subtree at one
   * tag and move it to the destination, leaving no temporary directory behind.
   */
  it("should check out only the named subtree and move it into place", async () => {
    const tmp = makeTmpDir("sous-fetch-subtree-");
    const calls: string[][] = [];
    const run: CommandRunner = async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "clone") {
        const checkoutDir = args[args.length - 1]!;
        const recipeDir = path.join(checkoutDir, "recipes/workflow/task-files");
        fs.mkdirSync(recipeDir, { recursive: true });
        fs.writeFileSync(path.join(recipeDir, "sous.recipe.yaml"), "formatVersion: 1\n");
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const destDir = path.join(tmp.path, "store", "task-files", "1.0.0");
    await fetchSubtree({
      cloneUrl: "https://github.com/owner/repo.git",
      tag: "workflow/task-files@1.0.0",
      subPath: "recipes/workflow/task-files",
      destDir,
      run,
    });

    expect(fs.existsSync(path.join(destDir, "sous.recipe.yaml"))).toBe(true);
    expect(calls[0]).toEqual(
      expect.arrayContaining(["clone", "--depth", "1", "--filter=blob:none", "--sparse"])
    );
    expect(calls[1]).toEqual([
      "git",
      "sparse-checkout",
      "set",
      "recipes/workflow/task-files",
    ]);
    const leftovers = fs
      .readdirSync(path.join(tmp.path, "store", "task-files"))
      .filter((entry) => entry.startsWith(".sous-fetch-"));
    expect(leftovers).toEqual([]);

    tmp.cleanup();
  });

  /**
   * When the tag does not actually carry the folder the index promised, the
   * error should say so rather than leaving an empty directory behind.
   */
  it("should raise a ConfigError when the tag does not contain the subtree", async () => {
    const tmp = makeTmpDir("sous-fetch-missing-");
    const run: CommandRunner = async () => ({ code: 0, stdout: "", stderr: "" });

    const promise = fetchSubtree({
      cloneUrl: "https://github.com/owner/repo.git",
      tag: "workflow/task-files@1.0.0",
      subPath: "recipes/workflow/task-files",
      destDir: path.join(tmp.path, "store", "task-files"),
      run,
    });

    await expect(promise).rejects.toThrow(/has no folder 'recipes\/workflow\/task-files'/);
    tmp.cleanup();
  });
});
