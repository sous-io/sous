import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../../../test/utils/tmp.js";
import { commitAll, git, initRepo, writeFile } from "../../../test/utils/git-repo.js";
import { spawnCommand, type CommandResult, type CommandRunner } from "../providers/git.js";
import { submitRepo } from "./submit-service.js";
import { buildIndex, indexFilePath } from "./index-builder.js";
import { validateRepo } from "./validate.js";

let tmp: TmpDir;
let repo: string;
let calls: Array<{ command: string; args: string[] }>;

/** The sous version recorded when the index is regenerated for the check. */
const GENERATOR = "1.2.3";

/** A successful result with the given standard output. */
function ok(stdout = ""): CommandResult {
  return { code: 0, stdout, stderr: "" };
}

/** A failed result with the given standard error. */
function fail(stderr: string, code = 1): CommandResult {
  return { code, stdout: "", stderr };
}

/**
 * A runner that lets real git run against the temporary repository, and answers
 * for the provider's CLI. A push is always intercepted: the origin URL has to
 * look like a real GitHub address for the provider to be detected, and no test
 * here is allowed to reach one. Every call is recorded, so a test can assert on
 * exactly what would have been sent.
 */
function makeRunner(
  answer: (command: string, args: string[]) => CommandResult | undefined
): CommandRunner {
  return async (command, args, options) => {
    calls.push({ command, args });
    const answered = answer(command, args);
    if (answered !== undefined) return answered;
    if (command === "git" && args[0] === "push") return ok("");
    if (command === "git") return spawnCommand(command, args, options);
    throw new Error(`unexpected command in this test: ${command} ${args.join(" ")}`);
  };
}

/** The provider CLI answers a well-behaved GitHub submission produces. */
function githubAnswers(overrides: Partial<Record<string, CommandResult>> = {}) {
  return (command: string, args: string[]): CommandResult | undefined => {
    if (command !== "gh") return undefined;
    const key = args.slice(0, 2).join(" ");
    if (Object.hasOwn(overrides, key)) return overrides[key];
    if (key === "auth status") return ok("");
    if (key === "api repos/owner/recipes") return ok("true\n");
    if (key === "api user") return ok("contributor\n");
    if (key === "repo fork") return ok("");
    if (key === "pr create") return ok("https://github.com/owner/recipes/pull/7\n");
    return undefined;
  };
}

/** Finds the recorded call to one command, by its first two arguments. */
function callTo(command: string, key: string) {
  return calls.find(
    (entry) => entry.command === command && entry.args.slice(0, 2).join(" ") === key
  );
}

beforeEach(() => {
  tmp = makeTmpDir("sous-submit-");
  repo = path.join(tmp.path, "recipes");
  calls = [];

  fs.mkdirSync(repo, { recursive: true });
  initRepo(repo);
  writeFile(
    repo,
    "sous.repo.yaml",
    "formatVersion: 1\nname: test-repo\ncontribute: Send a patch to recipes@example.com\n" +
      "namespaces:\n  core:\n    description: Core recipes.\nrecipes:\n  - recipes/core/example\n"
  );
  writeFile(
    repo,
    "recipes/core/example/sous.recipe.yaml",
    "formatVersion: 1\nnamespace: core\nname: example\nversion: 1.0.0\n"
  );
  writeFile(repo, "recipes/core/example/skills/one.md", "first\n");
  commitAll(repo, "add the example recipe");

  // A real GitHub address, so the provider is detected; every push is
  // intercepted by the runner, so nothing leaves the machine.
  git(repo, "remote", "add", "origin", "https://github.com/owner/recipes.git");
});

afterEach(() => {
  tmp.cleanup();
});

/** Writes the index the repository would have after a release, and commits it. */
async function commitCurrentIndex(): Promise<void> {
  const built = await buildIndex({
    validation: validateRepo(repo),
    existing: undefined,
    sousVersion: GENERATOR,
  });
  fs.writeFileSync(indexFilePath(repo), built.text, "utf8");
  commitAll(repo, "regenerate the index");
}

/** Runs a submission against the temporary repository. */
async function submit(
  run: CommandRunner,
  options: { dryRun?: boolean; title?: string; draft?: boolean } = {}
) {
  return submitRepo({
    rootDir: repo,
    sousVersion: GENERATOR,
    run,
    now: new Date(2026, 8, 10, 14, 3),
    ...options,
  });
}

describe("submitRepo()", () => {
  /**
   * The whole path, for a contributor who can push to the repository itself: a
   * branch is made, pushed to origin, and a pull request is opened against the
   * default branch with the title and body sous composed.
   */
  it("should branch, push to origin and open a pull request", async () => {
    await commitCurrentIndex();

    const result = await submit(makeRunner(githubAnswers()));

    expect(result.provider).toBe("github");
    expect(result.branch).toBe("sous/submit-20260910-1403");
    expect(result.usedFork).toBe(false);
    expect(result.pushedTo).toBe("origin");
    expect(result.url).toBe("https://github.com/owner/recipes/pull/7");
    expect(result.title).toBe("regenerate the index");

    const created = callTo("gh", "pr create")!;
    expect(created.args).toContain("--repo");
    expect(created.args).toContain("owner/recipes");
    expect(created.args).toContain("--head");
    expect(created.args).toContain("sous/submit-20260910-1403");
    expect(created.args).not.toContain("--draft");
    expect(created.args.join("\n")).toMatch(/core\/example at version 1\.0\.0/);
    expect(git(repo, "branch", "--list", "sous/submit-20260910-1403")).not.toBe("");
  });

  /**
   * A contributor who cannot push forks the repository first, and the pull
   * request's head names the fork's owner, which is what a cross-repository
   * proposal needs.
   */
  it("should fork and propose from the fork when the contributor cannot push", async () => {
    await commitCurrentIndex();

    const run = makeRunner(githubAnswers({ "api repos/owner/recipes": ok("false\n") }));

    const result = await submit(run);

    expect(result.usedFork).toBe(true);
    expect(result.pushedTo).toBe("fork");
    expect(callTo("gh", "repo fork")!.args).toContain("--remote=false");
    expect(callTo("gh", "pr create")!.args).toContain(
      "contributor:sous/submit-20260910-1403"
    );
    expect(git(repo, "remote", "get-url", "fork")).toBe(
      "https://github.com/contributor/recipes.git"
    );
  });

  /**
   * A draft proposal passes the flag through, so the maintainers see it is not
   * ready for review yet.
   */
  it("should open a draft when asked for one", async () => {
    await commitCurrentIndex();

    await submit(makeRunner(githubAnswers()), { draft: true, title: "Work in progress" });

    const created = callTo("gh", "pr create")!;
    expect(created.args).toContain("--draft");
    expect(created.args).toContain("Work in progress");
  });

  /**
   * A dry run checks everything and sends nothing: no branch, no push, no
   * proposal.
   */
  it("should check everything and send nothing on a dry run", async () => {
    await commitCurrentIndex();

    const result = await submit(makeRunner(githubAnswers()), { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(callTo("gh", "pr create")).toBeUndefined();
    expect(calls.some((entry) => entry.command === "git" && entry.args[0] === "push")).toBe(
      false
    );
    expect(git(repo, "branch", "--list", "sous/submit-20260910-1403")).toBe("");
  });

  /**
   * The provider's CLI is how the proposal is sent, so a missing or signed-out
   * one stops the run, and the message carries the repository's own
   * contribution pointer.
   */
  it("should stop and print the contribution pointer when the provider CLI is not usable", async () => {
    await commitCurrentIndex();

    const run = makeRunner((command, args) =>
      command === "gh" && args[0] === "auth" ? fail("not logged in", 1) : githubAnswers()(command, args)
    );

    await expect(submit(run)).rejects.toThrow(/recipes@example\.com/);
  });

  /**
   * Nothing is sent while the working tree has uncommitted changes, and the
   * message lists exactly what is outstanding.
   */
  it("should refuse while anything is uncommitted, listing what is", async () => {
    await commitCurrentIndex();
    writeFile(repo, "recipes/core/example/skills/two.md", "second\n");

    await expect(submit(makeRunner(githubAnswers()))).rejects.toThrow(
      /skills\/two\.md/
    );
  });

  /**
   * A proposal whose index is out of date would fail the maintainer's own
   * checks, so it is stopped here with the command that fixes it.
   */
  it("should refuse while the committed index is out of date", async () => {
    git(repo, "tag", "--annotate", "core/example@1.0.0", "--message", "release");

    await expect(submit(makeRunner(githubAnswers()))).rejects.toThrow(
      /Run 'sous repo release'/
    );
  });

  /**
   * A repository with no origin has nowhere to send a proposal, and the error
   * says how to give it one.
   */
  it("should refuse when the repository has no origin remote", async () => {
    await commitCurrentIndex();
    git(repo, "remote", "remove", "origin");

    await expect(submit(makeRunner(githubAnswers()))).rejects.toThrow(
      /no 'origin' remote/
    );
  });

  /**
   * A failure partway through says which steps completed, so a pushed branch
   * with no proposal behind it is never a silent surprise.
   */
  it("should report which steps completed when a step fails", async () => {
    await commitCurrentIndex();

    const run = makeRunner((command, args) =>
      command === "gh" && args.slice(0, 2).join(" ") === "pr create"
        ? fail("the API rejected the request")
        : githubAnswers()(command, args)
    );

    await expect(submit(run)).rejects.toThrow(/What had already been done/);
    await expect(submit(run)).rejects.toThrow(/Pushing 'sous\/submit-20260910-1403'/);
  });

  /**
   * A contributor already working on their own branch keeps it; sous only makes
   * a branch when the change would otherwise sit on the default one.
   */
  it("should keep the branch the contributor is already on", async () => {
    await commitCurrentIndex();
    git(repo, "checkout", "--quiet", "-b", "add-a-recipe");

    const result = await submit(makeRunner(githubAnswers()));

    expect(result.branch).toBe("add-a-recipe");
  });
});
