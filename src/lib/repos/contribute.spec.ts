import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../../test/utils/tmp.js";
import { commitAll, git, initRepo, writeFile } from "../../test/utils/git-repo.js";
import {
  assessPendingWork,
  assessProposal,
  commandLine,
  locatorArgs,
  pendingWork,
  startStep,
  submitStep,
  unlinkStep,
  type PendingWork,
} from "./contribute.js";

describe("startStep()", () => {
  /**
   * Starting links the repository with `--latest` on a new branch whose name
   * is generated when none was named.
   *
   * startStep("sous-recipes", {}).argv
   * // -> ["sous-recipes", "--latest", "--generate-branch"]
   */
  it("should link with --latest on a generated branch by default", () => {
    const step = startStep("sous-recipes", {});

    expect(step.command).toBe("repo:link");
    expect(step.argv).toEqual(["sous-recipes", "--latest", "--generate-branch"]);
  });

  /**
   * A named branch replaces the generated one, and the rest of the link flags
   * and the config-locating flags are passed through.
   *
   * startStep("r", { createBranch: "fix", from: "dev", global: true, yes: true }, { config: "x" }).argv
   * // -> ["r", "--latest", "--create-branch", "fix", "--from", "dev", "--global", "--yes", "--config", "x"]
   */
  it("should pass a named branch and the link flags through", () => {
    expect(
      startStep(
        "r",
        { createBranch: "fix", from: "dev", global: true, yes: true },
        { config: "x" }
      ).argv
    ).toEqual([
      "r",
      "--latest",
      "--create-branch",
      "fix",
      "--from",
      "dev",
      "--global",
      "--yes",
      "--config",
      "x",
    ]);
    expect(startStep("r", { branch: "existing" }).argv).toEqual([
      "r",
      "--latest",
      "--branch",
      "existing",
    ]);
  });
});

describe("submitStep()", () => {
  /**
   * The proposal flags are passed through, and the confirmation flag only
   * when it was given, so an unanswered question is still asked.
   *
   * submitStep("r", { title: "T", draft: true }).argv
   * // -> ["r", "--title", "T", "--draft"]
   */
  it("should pass the submit flags through, and --yes only when given", () => {
    expect(submitStep("r", { title: "T", draft: true }).argv).toEqual([
      "r",
      "--title",
      "T",
      "--draft",
    ]);
    expect(
      submitStep("r", {
        title: "T",
        body: "B",
        branch: "b",
        commit: true,
        yes: true,
        remove: true,
      }).argv
    ).toEqual(["r", "--title", "T", "--body", "B", "--branch", "b", "--commit", "--yes"]);
  });
});

describe("unlinkStep()", () => {
  /**
   * Finishing always unlinks with `--update`, and passes `--remove`,
   * `--global` and the confirmation flag through.
   *
   * unlinkStep("r", { remove: true }).argv
   * // -> ["r", "--update", "--remove"]
   */
  it("should unlink with --update and pass its flags through", () => {
    expect(unlinkStep("r", {}).argv).toEqual(["r", "--update"]);
    expect(unlinkStep("r", { remove: true, global: true, yes: true }, { "sous-dir": "d" }).argv).toEqual([
      "r",
      "--update",
      "--remove",
      "--global",
      "--yes",
      "--sous-dir",
      "d",
    ]);
    expect(unlinkStep("r", { remove: true }).running).toContain("deleting the checkout");
  });
});

describe("locatorArgs()", () => {
  /**
   * Each config-locating flag that was given becomes its argument pair, in a
   * fixed order.
   *
   * locatorArgs({ "sous-confd": "c", config: "a" })
   * // -> ["--config", "a", "--sous-confd", "c"]
   */
  it("should turn the given config-locating flags into arguments", () => {
    expect(locatorArgs({})).toEqual([]);
    expect(locatorArgs({ "sous-confd": "c", config: "a", "sous-dir": "b" })).toEqual([
      "--config",
      "a",
      "--sous-dir",
      "b",
      "--sous-confd",
      "c",
    ]);
  });
});

describe("commandLine()", () => {
  /**
   * A step reads as the command line that would run it, with any argument
   * holding a space or a quote quoted for a shell.
   *
   * commandLine(submitStep("r", { title: "It's done" }))
   * // -> "sous repo submit r --title 'It'\''s done'"
   */
  it("should write a step as a quoted command line", () => {
    expect(commandLine(startStep("sous-recipes", {}))).toBe(
      "sous repo link sous-recipes --latest --generate-branch"
    );
    expect(commandLine(submitStep("r", { title: "It's done" }))).toBe(
      "sous repo submit r --title 'It'\\''s done'"
    );
  });
});

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
  it("should find nothing on a branch with no commits of its own", () => {
    expect(pendingWork(checkout)).toEqual({
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
  it("should tell unpushed commits from pushed ones, and list uncommitted changes", () => {
    writeFile(checkout, "change.md", "change\n");
    commitAll(checkout, "a change");

    const before = pendingWork(checkout);
    expect(before.ahead).toHaveLength(1);
    expect(before.unpushed).toHaveLength(1);
    expect(before.unpushed[0]).toContain("a change");

    git(checkout, "push", "--quiet", "origin", "change");
    writeFile(checkout, "scratch.md", "scratch\n");

    const after = pendingWork(checkout);
    expect(after.ahead).toHaveLength(1);
    expect(after.unpushed).toEqual([]);
    expect(after.pushedCopies).toEqual(["origin/change"]);
    expect(after.uncommitted).toEqual(["?? scratch.md"]);
  });

  /**
   * A branch that is named but does not exist is an error naming it.
   */
  it("should refuse a branch the checkout does not have", () => {
    expect(() => pendingWork(checkout, "missing")).toThrow("no branch named 'missing'");
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
