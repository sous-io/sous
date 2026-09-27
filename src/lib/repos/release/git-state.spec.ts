import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../../../test/utils/tmp.js";
import { commitAll, git, initRepo, writeFile } from "../../../test/utils/git-repo.js";
import type { CommandRunner } from "../providers/git.js";
import {
  branchExists,
  commitEverything,
  createBranch,
  currentBranch,
  hasCommitIdentity,
  isCommittedAndUnchanged,
  pathsChangedSince,
  pushReportIsUpToDate,
  remoteUrl,
  submitBranchName,
  switchBranch,
  uncommittedChanges,
} from "./git-state.js";

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
   * uncommittedChanges(repo); // -> [{ status: " M", path: "sous.index.json" }]
   */
  it("should report every edited and untracked path, and nothing when clean", async () => {
    expect(await uncommittedChanges(repo)).toEqual([]);

    writeFile(repo, "sous.index.json", '{"formatVersion":1}\n');
    writeFile(repo, "notes.txt", "scratch\n");

    const changed = await uncommittedChanges(repo);

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
   * currentBranch(repo); // -> "main"
   */
  it("should name the checked-out branch and return undefined when HEAD is detached", async () => {
    expect(await currentBranch(repo)).toBe("main");

    await createBranch(repo, "sous/submit-20260101-1200");
    expect(await currentBranch(repo)).toBe("sous/submit-20260101-1200");

    git(repo, "checkout", "--quiet", "--detach", "HEAD");
    expect(await currentBranch(repo)).toBeUndefined();
  });
});

describe("remoteUrl()", () => {
  /**
   * A repository with no such remote yields undefined rather than failing, so a
   * preflight check can say so in its own words.
   *
   * remoteUrl(repo, "origin"); // -> "https://example.com/owner/repo.git"
   */
  it("should return the remote's URL, or undefined when there is no such remote", async () => {
    expect(await remoteUrl(repo, "origin")).toBeUndefined();

    git(repo, "remote", "add", "origin", "https://example.com/owner/repo.git");

    expect(await remoteUrl(repo, "origin")).toBe("https://example.com/owner/repo.git");
  });
});

describe("isCommittedAndUnchanged()", () => {
  /**
   * True only when the path is tracked AND identical to what HEAD holds, which
   * is how a release confirms the index it is about to publish is the one that
   * was committed.
   *
   * isCommittedAndUnchanged(repo, "sous.index.json"); // -> true
   */
  it("should be true only for a tracked path with no pending changes", async () => {
    expect(await isCommittedAndUnchanged(repo, "sous.index.json")).toBe(true);
    expect(await isCommittedAndUnchanged(repo, "never-added.json")).toBe(false);

    writeFile(repo, "sous.index.json", '{"formatVersion":1}\n');
    expect(await isCommittedAndUnchanged(repo, "sous.index.json")).toBe(false);
  });
});

describe("hasCommitIdentity()", () => {
  /**
   * A repository with `user.name` and `user.email` set can commit; one where
   * git refuses to work out an identity (an automation runner with no global
   * config, which is how the first automated release of sous failed) cannot,
   * and has to be caught before a release starts writing.
   *
   * hasCommitIdentity(repo); // -> true
   */
  it("should be true when git can name the author and false when it refuses to", async () => {
    expect(await hasCommitIdentity(repo)).toBe(true);

    // Exactly what git writes when the runner has no identity at all.
    const refusing: CommandRunner = async () => ({
      code: 128,
      stdout: "",
      stderr: "fatal: empty ident name (for <runner@fv-az.local>) not allowed",
    });

    expect(await hasCommitIdentity(repo, { run: refusing })).toBe(false);
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

    expect(await branchExists(repo, "other")).toBe(true);
    expect(await branchExists(repo, "missing")).toBe(false);

    await switchBranch(repo, "other");
    expect(await currentBranch(repo)).toBe("other");
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

    expect((await pathsChangedSince(repo, first)).sort()).toEqual(["a/one.md", "two.md"]);
    expect(await pathsChangedSince(repo, "HEAD")).toEqual([]);
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

    await commitEverything(repo, "Subject line\n\nThe body.");

    expect(await uncommittedChanges(repo)).toEqual([]);
    expect(git(repo, "log", "-1", "--format=%B")).toBe("Subject line\n\nThe body.");
  });
});
