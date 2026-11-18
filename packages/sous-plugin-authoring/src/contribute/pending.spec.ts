import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { commitAll, git, initRepo, makeTmpDir, writeFile, type TmpDir } from "../../test/support/git-repo.js";
import { realGit } from "../../test/support/standins.js";
import { RepoGit } from "../shared/git.js";
import { assessPendingWork, assessProposal, pendingWork as pending, type PendingWork } from "./pending.js";

/** What the checkout's branch holds. */
const pendingWork = (directory: string, branch?: string) => pending(new RepoGit(realGit(), directory), branch);

describe("pendingWork()", () => {
  let tmp: TmpDir;
  let upstream: string;
  let checkout: string;

  beforeEach(() => {
    tmp = makeTmpDir("sous-contribute-");
    upstream = path.join(tmp.path, "upstream");
    checkout = path.join(tmp.path, "checkout");
    git(tmp.path, "init", "--quiet", "--bare", "--initial-branch", "main", upstream);

    const seed = path.join(tmp.path, "seed");
    git(tmp.path, "init", "--quiet", "--initial-branch", "main", seed);
    initRepo(seed);
    writeFile(seed, "README.md", "readme\n");
    commitAll(seed, "first commit");
    git(seed, "push", "--quiet", upstream, "main");

    git(tmp.path, "clone", "--quiet", upstream, checkout);
    initRepo(checkout);
    git(checkout, "switch", "--quiet", "-c", "change");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  /**
   * A new branch with nothing on it holds nothing to propose.
   *
   * pendingWork(checkout)
   * // -> { branch: "change", baseBranch: "main", uncommitted: [], ahead: [], unpushed: [], pushedCopies: [] }
   */
  it("should find nothing on a branch with no commits of its own", async () => {
    expect(await pendingWork(checkout)).toEqual({
      branch: "change",
      baseBranch: "main",
      uncommitted: [],
      ahead: [],
      unpushed: [],
      pushedCopies: [],
    });
  });

  /**
   * A commit that was never pushed is both ahead of the default branch and
   * unpushed; once it is pushed, the pushed copy is named and nothing is
   * unpushed. An uncommitted change is listed as well.
   *
   * pendingWork(checkout).unpushed // -> ["1a2b3c4 a change"]
   */
  it("should tell unpushed commits from pushed ones, and list uncommitted changes", async () => {
    writeFile(checkout, "change.md", "change\n");
    commitAll(checkout, "a change");

    const before = await pendingWork(checkout);
    expect(before.ahead).toHaveLength(1);
    expect(before.unpushed).toHaveLength(1);
    expect(before.unpushed[0]).toContain("a change");

    git(checkout, "push", "--quiet", "origin", "change");
    writeFile(checkout, "scratch.md", "scratch\n");

    const after = await pendingWork(checkout);
    expect(after.ahead).toHaveLength(1);
    expect(after.unpushed).toEqual([]);
    expect(after.pushedCopies).toEqual(["origin/change"]);
    expect(after.uncommitted).toEqual(["?? scratch.md"]);
  });

  /**
   * A branch that is named but does not exist is an error naming it.
   */
  it("should refuse a branch the checkout does not have", async () => {
    await expect(pendingWork(checkout, "missing")).rejects.toThrow("no branch named 'missing'");
  });
});

describe("assessPendingWork()", () => {
  const work = (overrides: Partial<PendingWork>): PendingWork => ({
    branch: "fix",
    baseBranch: "main",
    uncommitted: [],
    ahead: [],
    unpushed: [],
    pushedCopies: [],
    ...overrides,
  });

  /**
   * Uncommitted changes and unpushed commits are work to submit; a branch with
   * no commits of its own is not; a branch whose every commit was pushed needs
   * its proposal looked up.
   *
   * assessPendingWork(work({ ahead: ["a"], unpushed: ["a"] })).kind // -> "pending"
   */
  it("should judge each kind of branch", () => {
    expect(assessPendingWork(work({ uncommitted: ["M a.md"] })).kind).toBe("pending");

    const nothing = assessPendingWork(work({}));
    expect(nothing.kind).toBe("nothing");
    expect(nothing.reason).toContain("holds no commits that origin/main lacks");

    const unpushed = assessPendingWork(work({ ahead: ["a"], unpushed: ["a"] }));
    expect(unpushed.kind).toBe("pending");
    expect(unpushed.reason).toContain("1 commit that has never been pushed");

    const partly = assessPendingWork(
      work({ ahead: ["a", "b"], unpushed: ["b"], pushedCopies: ["origin/fix"] })
    );
    expect(partly.reason).toContain("1 commit that origin/fix lacks");

    const pushed = assessPendingWork(work({ ahead: ["a"], pushedCopies: ["origin/fix"] }));
    expect(pushed.kind).toBe("lookup");
  });
});

describe("assessProposal()", () => {
  const proposal = (state: "open" | "merged" | "closed") => ({
    id: "7",
    state,
    title: "Fix",
    draft: false,
    url: "https://example.invalid/pull/7",
  });

  /**
   * An open or merged proposal already carries a pushed branch; no proposal,
   * or one closed without merging, leaves it to submit.
   *
   * assessProposal("fix", undefined, "pull request").kind // -> "pending"
   */
  it("should judge a pushed branch by its proposal", () => {
    expect(assessProposal("fix", undefined, "pull request")).toEqual({
      kind: "pending",
      reason: "Every commit on the branch 'fix' was pushed, but no pull request is open for it.",
    });
    expect(assessProposal("fix", proposal("open"), "pull request").kind).toBe("nothing");
    expect(assessProposal("fix", proposal("merged"), "pull request").kind).toBe("nothing");
    expect(assessProposal("fix", proposal("closed"), "pull request").kind).toBe("pending");
  });
});
