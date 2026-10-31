import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { GitRunner } from "@sous-io/plugin-git/types";
import { commitAll, git, initRepo, makeTmpDir, writeFile, type TmpDir } from "../../test/support/git-repo.js";
import { realGit } from "../../test/support/standins.js";
import { pushReportIsUpToDate, RepoGit, submitBranchName } from "./git.js";

/** Git, bound to the test repository. */
const rg = () => new RepoGit(realGit(), repo);

let tmp: TmpDir;
let repo: string;

beforeEach(() => {
  tmp = makeTmpDir("sous-release-state-");
  repo = tmp.path;
  initRepo(repo);
  writeFile(repo, "sous.index.json", "{}\n");
  commitAll(repo, "first commit");
});

afterEach(() => {
  tmp.cleanup();
});

describe("uncommittedChanges()", () => {
  /**
   * A clean working tree reports nothing; an edited or untracked file is
   * reported with the status git gave it, so a command can list exactly what
   * the author still has to commit.
   *
   * rg().uncommittedChanges(); // -> [{ status: " M", path: "sous.index.json" }]
   */
  it("should report every edited and untracked path, and nothing when clean", async () => {
    expect(await rg().uncommittedChanges()).toEqual([]);

    writeFile(repo, "sous.index.json", '{"formatVersion":1}\n');
    writeFile(repo, "notes.txt", "scratch\n");

    const changed = await rg().uncommittedChanges();

    expect(changed.map((entry) => entry.path).sort()).toEqual([
      "notes.txt",
      "sous.index.json",
    ]);
  });
});

describe("currentBranch()", () => {
  /**
   * The checked-out branch comes back by name; a detached HEAD has no branch
   * and yields undefined rather than the literal string "HEAD".
   *
   * rg().currentBranch(); // -> "main"
   */
  it("should name the checked-out branch and return undefined when HEAD is detached", async () => {
    expect(await rg().currentBranch()).toBe("main");

    await rg().createBranch("sous/submit-20260101-1200");
    expect(await rg().currentBranch()).toBe("sous/submit-20260101-1200");

    git(repo, "checkout", "--quiet", "--detach", "HEAD");
    expect(await rg().currentBranch()).toBeUndefined();
  });
});

describe("remoteUrl()", () => {
  /**
   * A repository with no such remote yields undefined rather than failing, so a
   * preflight check can say so in its own words.
   *
   * rg().remoteUrl("origin"); // -> "https://example.com/owner/repo.git"
   */
  it("should return the remote's URL, or undefined when there is no such remote", async () => {
    expect(await rg().remoteUrl("origin")).toBeUndefined();

    git(repo, "remote", "add", "origin", "https://example.com/owner/repo.git");

    expect(await rg().remoteUrl("origin")).toBe("https://example.com/owner/repo.git");
  });
});

describe("hasCommitIdentity()", () => {
  /**
   * A repository with `user.name` and `user.email` set can commit; one where
   * git refuses to work out an identity (an automation runner with no global
   * config, which is how the first automated release of sous failed) cannot,
   * and has to be caught before a release starts writing.
   *
   * rg().hasCommitIdentity(); // -> true
   */
  it("should be true when git can name the author and false when it refuses to", async () => {
    expect(await rg().hasCommitIdentity()).toBe(true);

    // Exactly what git writes when the runner has no identity at all.
    const refusing: GitRunner = {
      ...realGit(),
      run: async (args) => ({
        args,
        exitCode: 128,
        stdout: "",
        stderr: "fatal: empty ident name (for <runner@fv-az.local>) not allowed",
        durationMs: 0,
      }),
    };

    expect(await new RepoGit(refusing, repo).hasCommitIdentity()).toBe(false);
  });
});

describe("submitBranchName()", () => {
  /**
   * The proposed branch is stamped down to the minute, so two submissions from
   * one checkout never collide.
   *
   * submitBranchName(new Date(2026, 8, 10, 14, 3));
   * // -> "sous/submit-20260910-1403"
   */
  it("should stamp the branch name with the local date and time", () => {
    expect(submitBranchName(new Date(2026, 8, 10, 14, 3))).toBe(
      "sous/submit-20260910-1403"
    );
  });
});

describe("pushReportIsUpToDate()", () => {
  /**
   * A push report whose every ref line is flagged `=` sent nothing; any other
   * flag, or a report with no ref lines, means something may have been sent.
   *
   * pushReportIsUpToDate("To o\n=\trefs/heads/a:refs/heads/a\t[up to date]\nDone");
   * // -> true
   */
  it("should read an up-to-date push from git's porcelain report", () => {
    expect(
      pushReportIsUpToDate("To origin\n=\trefs/heads/a:refs/heads/a\t[up to date]\nDone")
    ).toBe(true);
    expect(
      pushReportIsUpToDate("To origin\n \trefs/heads/a:refs/heads/a\t1a2b..3c4d\nDone")
    ).toBe(false);
    expect(pushReportIsUpToDate("To origin\n*\trefs/heads/a:refs/heads/a\t[new branch]\nDone")).toBe(
      false
    );
    expect(pushReportIsUpToDate("")).toBe(false);
  });
});

describe("branchExists() and switchBranch()", () => {
  /**
   * A local branch is found by name, and checking it out makes it current.
   */
  it("should find a local branch and check it out", async () => {
    git(repo, "branch", "other");

    expect(await rg().branchExists("other")).toBe(true);
    expect(await rg().branchExists("missing")).toBe(false);

    await rg().switchBranch("other");
    expect(await rg().currentBranch()).toBe("other");
  });
});

describe("pathsChangedSince()", () => {
  /**
   * Every path the commits since a given one touched is listed.
   */
  it("should list the paths changed since a commit", async () => {
    const first = git(repo, "rev-parse", "HEAD");
    writeFile(repo, "a/one.md", "one\n");
    writeFile(repo, "two.md", "two\n");
    commitAll(repo, "add two files");

    expect((await rg().pathsChangedSince(first)).sort()).toEqual(["a/one.md", "two.md"]);
    expect(await rg().pathsChangedSince("HEAD")).toEqual([]);
  });
});

describe("commitEverything()", () => {
  /**
   * Edits, deletions and untracked files are all committed, with the message
   * given, and the working tree is clean afterwards.
   */
  it("should stage and commit everything with the given message", async () => {
    writeFile(repo, "new.md", "new\n");
    writeFile(repo, "sous.index.json", '{"changed":true}\n');

    await rg().commitEverything("Subject line\n\nThe body.");

    expect(await rg().uncommittedChanges()).toEqual([]);
    expect(git(repo, "log", "-1", "--format=%B")).toBe("Subject line\n\nThe body.");
  });
});

describe("pushBranch()", () => {
  /**
   * A push to a remote whose fetch configuration does not cover the branch
   * (what a single-branch clone looks like) still leaves a remote-tracking
   * branch behind recording what was pushed, so the checkout can tell later
   * that its commits exist on the remote.
   *
   * await rg().pushBranch("origin", "change");
   * // -> refs/remotes/origin/change points at the pushed commit
   */
  it("should record what it pushed even when the fetch configuration does not cover the branch", async () => {
    const remote = makeTmpDir("sous-release-remote-");
    try {
      git(remote.path, "init", "--quiet", "--bare", "--initial-branch", "main");
      git(repo, "remote", "add", "origin", remote.path);
      git(repo, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
      git(repo, "switch", "--quiet", "-c", "change");
      writeFile(repo, "change.md", "change\n");
      commitAll(repo, "a change");

      expect(await rg().pushBranch("origin", "change")).toBe("updated");

      expect(git(repo, "rev-parse", "refs/remotes/origin/change")).toBe(
        git(repo, "rev-parse", "HEAD")
      );
      expect(await rg().pushBranch("origin", "change")).toBe("up-to-date");
    } finally {
      remote.cleanup();
    }
  });
});
