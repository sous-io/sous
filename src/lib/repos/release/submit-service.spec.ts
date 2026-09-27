/**
 * Unit tests for the submission sequencer.
 *
 * The provider is a fake implementing the provider interface, which is the
 * point: `submitRepo` is meant to know the ORDER of the steps and nothing about
 * the host, so every host-specific answer here comes from a stand-in and every
 * test can assert on what the sequencer asked for. Real git runs against a
 * temporary repository; a push is intercepted, and a call to anything that is
 * not git fails the test outright.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeTmpDir, type TmpDir } from "../../../test/utils/tmp.js";
import { commitAll, git, initRepo, writeFile } from "../../../test/utils/git-repo.js";
import { ProviderBase } from "../providers/base.js";
import { spawnCommand, type CommandResult, type CommandRunner } from "../providers/git.js";
import {
  buildCanonicalRepo,
  splitRepoUrl,
  type AuthStatus,
  type CanonicalRepo,
  type ChangeProposal,
  type FetchedIndex,
  type ForkedRepo,
  type ProposalQuery,
  type ProposalStatus,
  type ProposalSummary,
  type ProposalUpdate,
  type ProposedChange,
  type ProviderCli,
  type ProviderFeature,
  type ProviderOptions,
} from "../providers/provider.js";
import { submitRepo, type SubmitOptions, type SubmitQuestions } from "./submit-service.js";
import { buildIndex, indexFilePath } from "./index-builder.js";
import { validateRepo } from "./validate.js";

let tmp: TmpDir;
let repo: string;
let calls: Array<{ command: string; args: string[] }>;

/** The sous version the test repository's index records as its generator. */
const GENERATOR = "1.2.3";

/** What the fake provider should answer on the write path. */
type FakeAnswers = {
  /** What the sign-in check reports. Defaults to signed in. */
  auth?: AuthStatus;
  /** What push permission comes back as. Defaults to "you may push". */
  canPush?: boolean | undefined;
  /** When set, forking fails with this message. */
  forkError?: string;
  /** When set, proposing fails with this message. */
  proposeError?: string;
  /** The address the proposal reports. Defaults to a pull request URL. */
  proposalUrl?: string;
  /** The features the provider declares. Defaults to fetch, submit and proposals. */
  features?: ProviderFeature[];
  /** The proposal a branch lookup finds. Defaults to none. */
  existing?: ProposalSummary;
};

/**
 * A provider stand-in. It answers the write path from a table and records every
 * call, so a test sees exactly what the sequencer asked of it, in order.
 */
class FakeProvider extends ProviderBase {
  readonly id = "github" as const;
  readonly features: ProviderFeature[];
  readonly cli: ProviderCli = {
    command: "fake-cli",
    label: "the stand-in host CLI",
    install: "https://example.com/install",
  };
  readonly proposalNoun = "pull request";

  /** Every write-path call the sequencer made, in order. */
  readonly asked: string[] = [];

  /** The proposal the sequencer composed, once it has composed one. */
  proposal: ChangeProposal | undefined;

  /** The lookup the sequencer made, once it has made one. */
  query: ProposalQuery | undefined;

  /** The update the sequencer asked for, once it has asked for one. */
  update: ProposalUpdate | undefined;

  constructor(private readonly answers: FakeAnswers = {}) {
    super();
    this.features = answers.features ?? ["fetch", "submit", "proposals"];
  }

  matches(url: string): boolean {
    return splitRepoUrl(url)?.host === "github.com";
  }

  canonicalize(url: string): CanonicalRepo {
    const parts = splitRepoUrl(url)!;
    return buildCanonicalRepo(parts.host, parts.owner, parts.name);
  }

  async fetchIndex(): Promise<FetchedIndex> {
    throw new Error("the submission never reads an index through the provider");
  }

  async fetchRecipeTree(): Promise<void> {
    throw new Error("the submission never fetches a recipe tree");
  }

  async authStatus(_options: ProviderOptions = {}): Promise<AuthStatus> {
    this.asked.push("authStatus");
    return this.answers.auth ?? { ok: true, detail: "signed in to the stand-in host." };
  }

  async canPush(
    _repo: CanonicalRepo,
    _options: ProviderOptions = {}
  ): Promise<boolean | undefined> {
    this.asked.push("canPush");
    return "canPush" in this.answers ? this.answers.canPush : true;
  }

  async fork(repo: CanonicalRepo, _options: ProviderOptions = {}): Promise<ForkedRepo> {
    this.asked.push("fork");
    if (this.answers.forkError !== undefined) throw new Error(this.answers.forkError);
    return {
      owner: "contributor",
      name: repo.name,
      httpsUrl: `https://${repo.host}/contributor/${repo.name}.git`,
      sshUrl: `git@${repo.host}:contributor/${repo.name}.git`,
    };
  }

  async proposeChange(
    _repo: CanonicalRepo,
    proposal: ChangeProposal,
    _options: ProviderOptions = {}
  ): Promise<ProposedChange> {
    this.asked.push("proposeChange");
    this.proposal = proposal;
    if (this.answers.proposeError !== undefined) throw new Error(this.answers.proposeError);
    const url = this.answers.proposalUrl ?? "https://github.com/owner/recipes/pull/7";
    return { url, detail: `The pull request is at ${url}.` };
  }

  async findProposal(
    _repo: CanonicalRepo,
    query: ProposalQuery,
    _options: ProviderOptions = {}
  ): Promise<ProposalSummary | undefined> {
    this.asked.push("findProposal");
    this.query = query;
    return this.answers.existing;
  }

  async proposalStatus(
    _repo: CanonicalRepo,
    id: string,
    _options: ProviderOptions = {}
  ): Promise<ProposalStatus> {
    this.asked.push("proposalStatus");
    return {
      proposal: { ...(this.answers.existing ?? { state: "open", title: "", draft: false }), id },
      review: "review required",
      checks: { passed: 2, failed: 0, pending: 1 },
    };
  }

  async updateProposal(
    _repo: CanonicalRepo,
    _id: string,
    update: ProposalUpdate,
    _options: ProviderOptions = {}
  ): Promise<ProposedChange> {
    this.asked.push("updateProposal");
    this.update = update;
    return { url: this.answers.existing?.url, detail: "updated" } as ProposedChange;
  }
}

/** How the runner answers a push. Defaults to "sent new commits". */
let pushAnswer: CommandResult;

/** When true, `git var` fails, as it does when git cannot tell who is committing. */
let noIdentity: boolean;

/**
 * A runner that lets real git run against the temporary repository. A push is
 * always intercepted: the origin URL has to look like a real GitHub address for
 * the provider to match it, and no test here is allowed to reach one. Anything
 * that is not git fails the test, which is how these tests prove the sequencer
 * never spawns a provider's command line tool itself.
 */
function makeRunner(): CommandRunner {
  return async (command, args, options) => {
    calls.push({ command, args });
    if (command === "git" && args[0] === "push") return pushAnswer;
    if (command === "git" && args[0] === "var" && noIdentity) {
      return { code: 128, stdout: "", stderr: "fatal: empty ident name not allowed" };
    }
    if (command === "git") return spawnCommand(command, args, options);
    throw new Error(
      `the sequencer spawned '${command}' itself; the provider owns every host command`
    );
  };
}

/** Questions that answer from a table and record what was asked. */
function recordingQuestions(answers: Partial<SubmitQuestions> = {}) {
  const asked: string[] = [];
  const questions: SubmitQuestions = {
    title: async () => {
      asked.push("title");
      return answers.title ? answers.title() : "Asked title";
    },
    body: async () => {
      asked.push("body");
      return answers.body ? answers.body() : "Asked description.";
    },
    confirmCommit: async (paths) => {
      asked.push("confirmCommit");
      return answers.confirmCommit ? answers.confirmCommit(paths) : true;
    },
    proceedDespiteSubmissions: async (refusing) => {
      asked.push("proceedDespiteSubmissions");
      return answers.proceedDespiteSubmissions
        ? answers.proceedDespiteSubmissions(refusing)
        : true;
    },
    nextBranch: async (merged, generated) => {
      asked.push("nextBranch");
      return answers.nextBranch ? answers.nextBranch(merged, generated) : { kind: "generate" };
    },
  };
  return { questions, asked };
}

beforeEach(() => {
  tmp = makeTmpDir("sous-submit-");
  repo = path.join(tmp.path, "recipes");
  calls = [];
  pushAnswer = { code: 0, stdout: "", stderr: "" };
  noIdentity = false;

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

  // A real GitHub address, so the stand-in provider matches it; every push is
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

/** Moves the upstream default branch to HEAD, as a maintainer's push would. */
function publishUpstream(): void {
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
}

/** Runs a submission against the temporary repository, through one provider. */
async function submit(
  provider: FakeProvider,
  options: Partial<Omit<SubmitOptions, "rootDir" | "run" | "providers">> = {}
) {
  return submitRepo({
    rootDir: repo,
    run: makeRunner(),
    providers: [provider],
    now: new Date(2026, 8, 10, 14, 3),
    title: "Add a skill",
    body: "It adds a skill.",
    ...options,
  });
}

/** An open proposal, as the stand-in host would report it. */
const OPEN: ProposalSummary = {
  id: "7",
  url: "https://github.com/owner/recipes/pull/7",
  state: "open",
  title: "Add a skill",
  draft: false,
  base: "main",
};

describe("submitRepo()", () => {
  describe("opening a proposal", () => {
    /**
     * The whole path, for a contributor who can push to the repository itself: a
     * branch is made, pushed to origin, and the provider is handed a proposal
     * against the default branch with the given title and a body made of the
     * description and the changelog.
     */
    it("should branch, push to origin and ask the provider to propose the change", async () => {
      await commitCurrentIndex();
      const provider = new FakeProvider();

      const result = await submit(provider);

      expect(result.outcome).toBe("created");
      expect(result.provider).toBe("github");
      expect(result.branch).toBe("sous/submit-20260910-1403");
      expect(result.usedFork).toBe(false);
      expect(result.pushedTo).toBe("origin");
      expect(result.url).toBe("https://github.com/owner/recipes/pull/7");
      expect(result.title).toBe("Add a skill");

      expect(provider.asked).toEqual(["authStatus", "canPush", "proposeChange"]);
      expect(provider.proposal?.branch).toBe("sous/submit-20260910-1403");
      expect(provider.proposal?.head).toBeUndefined();
      expect(provider.proposal?.draft).toBe(false);
      expect(provider.proposal?.body).toMatch(/^It adds a skill\.\n\n## What merging this changes/);
      expect(git(repo, "branch", "--list", "sous/submit-20260910-1403")).not.toBe("");
    });

    /**
     * The sequencer owns no host command. Everything it spawns for itself is git;
     * the fork and the proposal are asked of the provider.
     *
     * calls.every((entry) => entry.command === "git");  // -> true
     */
    it("should spawn nothing but git of its own accord", async () => {
      await commitCurrentIndex();

      await submit(new FakeProvider({ canPush: false }));

      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((entry) => entry.command === "git")).toBe(true);
    });

    /**
     * A push is never forced; the arguments carry no force flag of any kind.
     */
    it("should never force a push", async () => {
      await commitCurrentIndex();

      await submit(new FakeProvider());

      const pushes = calls.filter((entry) => entry.args[0] === "push");
      expect(pushes.length).toBe(1);
      expect(pushes[0]!.args.some((arg) => /force|^-f$|^\+/.test(arg))).toBe(false);
    });

    /**
     * A contributor who cannot push has the repository forked by the provider,
     * and the proposal names the fork's owner as its head, which is what a
     * cross-repository proposal needs.
     */
    it("should fork and propose from the fork when the contributor cannot push", async () => {
      await commitCurrentIndex();
      const provider = new FakeProvider({ canPush: false });

      const result = await submit(provider);

      expect(result.usedFork).toBe(true);
      expect(result.pushedTo).toBe("fork");
      expect(provider.asked).toEqual(["authStatus", "canPush", "fork", "proposeChange"]);
      expect(provider.proposal?.head).toEqual({ owner: "contributor" });
      expect(git(repo, "remote", "get-url", "fork")).toBe(
        "https://github.com/contributor/recipes.git"
      );
    });

    /**
     * A provider that cannot tell whether the contributor may push is taken at
     * its word: nothing is forked, the change goes to origin, and the
     * contributor is told why.
     */
    it("should push to origin and say so when push permission is unknowable", async () => {
      await commitCurrentIndex();
      const notices: string[] = [];
      const provider = new FakeProvider({ canPush: undefined });

      const result = await submit(provider, { onNotice: (message) => notices.push(message) });

      expect(result.usedFork).toBe(false);
      expect(result.pushedTo).toBe("origin");
      expect(provider.asked).not.toContain("fork");
      expect(notices.join("\n")).toMatch(/could not tell whether you can push/);
    });

    /**
     * A draft proposal reaches the provider as a draft, so the maintainers see it
     * is not ready for review yet.
     */
    it("should pass a draft and a given title through to the provider", async () => {
      await commitCurrentIndex();
      const provider = new FakeProvider();

      await submit(provider, { draft: true, title: "Work in progress" });

      expect(provider.proposal?.draft).toBe(true);
      expect(provider.proposal?.title).toBe("Work in progress");
    });

    /**
     * A new proposal needs a title and a description written by a person; sous
     * never borrows a commit message. Whichever is missing is asked for.
     */
    it("should ask for a missing title and description", async () => {
      await commitCurrentIndex();
      const provider = new FakeProvider();
      const { questions, asked } = recordingQuestions();

      await submit(provider, { title: undefined, body: undefined, questions });

      expect(asked).toEqual(["title", "body"]);
      expect(provider.proposal?.title).toBe("Asked title");
      expect(provider.proposal?.body).toMatch(/^Asked description\./);
    });

    /**
     * With nothing to ask with, a missing title stops the run before anything is
     * written, and no branch is left behind.
     */
    it("should refuse a new proposal without a title when nothing can ask", async () => {
      await commitCurrentIndex();

      await expect(submit(new FakeProvider(), { title: undefined })).rejects.toThrow(
        /needs a title/
      );
      expect(git(repo, "branch", "--list", "sous/submit-*")).toBe("");
    });

    /**
     * A dry run checks everything and sends nothing: no branch, no push, no
     * fork, no proposal.
     */
    it("should check everything and send nothing on a dry run", async () => {
      await commitCurrentIndex();
      const provider = new FakeProvider({ canPush: false });

      const result = await submit(provider, { dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(provider.asked).toEqual(["authStatus", "canPush"]);
      expect(calls.some((entry) => entry.command === "git" && entry.args[0] === "push")).toBe(
        false
      );
      expect(git(repo, "branch", "--list", "sous/submit-20260910-1403")).toBe("");
    });

    /**
     * A contributor already working on their own branch keeps it; sous only makes
     * a branch when the change would otherwise sit on the default one.
     */
    it("should keep the branch the contributor is already on", async () => {
      await commitCurrentIndex();
      git(repo, "checkout", "--quiet", "-b", "add-a-recipe");

      const result = await submit(new FakeProvider());

      expect(result.branch).toBe("add-a-recipe");
    });

    /**
     * `--branch` naming a branch that does not exist creates it from the current
     * commit, instead of a generated name.
     */
    it("should create the branch --branch names when it does not exist", async () => {
      await commitCurrentIndex();
      const provider = new FakeProvider();

      const result = await submit(provider, { branch: "my-change" });

      expect(result.branch).toBe("my-change");
      expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("my-change");
      expect(provider.query?.branch).toBe("my-change");
    });

    /**
     * `--branch` naming an existing branch checks it out and works with it.
     */
    it("should check out the existing branch --branch names", async () => {
      await commitCurrentIndex();
      git(repo, "branch", "elsewhere");

      const result = await submit(new FakeProvider(), { branch: "elsewhere" });

      expect(result.branch).toBe("elsewhere");
      expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("elsewhere");
    });
  });

  describe("the lifecycle of an existing proposal", () => {
    /**
     * An open proposal with new commits is updated by the push itself, and is
     * never opened twice.
     */
    it("should push to an open proposal and report it as updated", async () => {
      await commitCurrentIndex();
      git(repo, "checkout", "--quiet", "-b", "add-a-skill");
      const provider = new FakeProvider({ existing: OPEN });

      const result = await submit(provider, { title: undefined, body: undefined });

      expect(result.outcome).toBe("updated");
      expect(result.url).toBe(OPEN.url);
      expect(provider.asked).not.toContain("proposeChange");
      expect(provider.asked).not.toContain("updateProposal");
      expect(provider.asked).toContain("proposalStatus");
    });

    /**
     * On an update, a given title and description replace the proposal's own;
     * the description still carries the changelog.
     */
    it("should replace an open proposal's title and body when they are given", async () => {
      await commitCurrentIndex();
      git(repo, "checkout", "--quiet", "-b", "add-a-skill");
      const provider = new FakeProvider({ existing: OPEN });

      await submit(provider, { title: "A better title", body: "A better description." });

      expect(provider.update?.title).toBe("A better title");
      expect(provider.update?.body).toMatch(/^A better description\.\n\n## What merging/);
    });

    /**
     * With nothing new to push and no new text, the proposal is left alone and
     * its status is reported.
     */
    it("should report an open proposal as unchanged when nothing is new", async () => {
      await commitCurrentIndex();
      git(repo, "checkout", "--quiet", "-b", "add-a-skill");
      pushAnswer = {
        code: 0,
        stdout: "To https://github.com/owner/recipes.git\n=\trefs/heads/add-a-skill:refs/heads/add-a-skill\t[up to date]\nDone",
        stderr: "",
      };
      const provider = new FakeProvider({ existing: OPEN });

      const result = await submit(provider, { title: undefined, body: undefined });

      expect(result.outcome).toBe("unchanged");
      expect(result.status?.checks).toEqual({ passed: 2, failed: 0, pending: 1 });
    });

    /**
     * A branch whose proposal was merged takes no further changes. The
     * contributor chooses a new branch, and the new branch gets a new proposal.
     */
    it("should continue a merged proposal on a generated branch", async () => {
      await commitCurrentIndex();
      git(repo, "checkout", "--quiet", "-b", "add-a-skill");
      const provider = new FakeProvider({ existing: { ...OPEN, state: "merged" } });
      const { questions, asked } = recordingQuestions();

      const result = await submit(provider, { questions });

      expect(asked).toContain("nextBranch");
      expect(result.outcome).toBe("created");
      expect(result.branch).toBe("sous/submit-20260910-1403");
      expect(result.previous?.state).toBe("merged");
      expect(provider.asked).toContain("proposeChange");
    });

    /**
     * The contributor may name the new branch themselves.
     */
    it("should continue a merged proposal on the branch the contributor names", async () => {
      await commitCurrentIndex();
      git(repo, "checkout", "--quiet", "-b", "add-a-skill");
      const provider = new FakeProvider({ existing: { ...OPEN, state: "merged" } });
      const { questions } = recordingQuestions({
        nextBranch: async () => ({ kind: "name", name: "add-another-skill" }),
      });

      const result = await submit(provider, { questions });

      expect(result.branch).toBe("add-another-skill");
      expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("add-another-skill");
    });

    /**
     * Cancelling after a merge writes nothing at all.
     */
    it("should write nothing when the contributor cancels after a merge", async () => {
      await commitCurrentIndex();
      git(repo, "checkout", "--quiet", "-b", "add-a-skill");
      const provider = new FakeProvider({ existing: { ...OPEN, state: "merged" } });
      const { questions } = recordingQuestions({ nextBranch: async () => ({ kind: "cancel" }) });

      const result = await submit(provider, { questions });

      expect(result.outcome).toBe("cancelled");
      expect(calls.some((entry) => entry.args[0] === "push")).toBe(false);
      expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("add-a-skill");
    });

    /**
     * A proposal closed without merging is reported, and a fresh one is opened
     * for the same branch.
     */
    it("should open a fresh proposal when the last one was closed", async () => {
      await commitCurrentIndex();
      git(repo, "checkout", "--quiet", "-b", "add-a-skill");
      const notices: string[] = [];
      const provider = new FakeProvider({ existing: { ...OPEN, state: "closed" } });

      const result = await submit(provider, { onNotice: (message) => notices.push(message) });

      expect(result.outcome).toBe("created");
      expect(result.branch).toBe("add-a-skill");
      expect(notices.join("\n")).toMatch(/closed without being merged/);
    });

    /**
     * A pushed branch holding commits the local one lacks makes git refuse the
     * push. The refusal reaches the contributor, and nothing is opened.
     */
    it("should pass git's refusal through when the pushed branch has moved on", async () => {
      await commitCurrentIndex();
      git(repo, "checkout", "--quiet", "-b", "add-a-skill");
      pushAnswer = {
        code: 1,
        stdout: "",
        stderr: " ! [rejected]        add-a-skill -> add-a-skill (non-fast-forward)",
      };
      const provider = new FakeProvider({ existing: OPEN });

      await expect(submit(provider)).rejects.toThrow(/non-fast-forward[\s\S]*never forces a push/);
      expect(provider.asked).not.toContain("updateProposal");
    });

    /**
     * A proposal opened from a fork is looked up by the fork's owner as well as
     * the branch, read from the fork remote when there is one.
     */
    it("should look a fork's proposal up by the fork owner", async () => {
      await commitCurrentIndex();
      git(repo, "remote", "add", "fork", "https://github.com/contributor/recipes.git");
      git(repo, "checkout", "--quiet", "-b", "add-a-skill");
      const provider = new FakeProvider({ canPush: false, existing: OPEN });

      await submit(provider);

      expect(provider.query).toEqual({
        branch: "add-a-skill",
        fromFork: true,
        forkOwner: "contributor",
      });
    });

    /**
     * A provider that cannot look proposals up still opens one, and says why it
     * could not check for an existing one.
     */
    it("should open a proposal and say so when the provider cannot look one up", async () => {
      await commitCurrentIndex();
      const notices: string[] = [];
      const provider = new FakeProvider({ features: ["fetch", "submit"] });

      const result = await submit(provider, { onNotice: (message) => notices.push(message) });

      expect(result.outcome).toBe("created");
      expect(notices.join("\n")).toMatch(/cannot look for a pull request that is already open/);
    });
  });

  describe("--status", () => {
    /**
     * `--status` reports where the branch's proposal stands and changes nothing.
     */
    it("should report the proposal and change nothing", async () => {
      await commitCurrentIndex();
      git(repo, "checkout", "--quiet", "-b", "add-a-skill");
      writeFile(repo, "scratch.md", "uncommitted\n");
      const provider = new FakeProvider({ existing: OPEN });

      const result = await submit(provider, { statusOnly: true });

      expect(result.outcome).toBe("status");
      expect(result.status?.review).toBe("review required");
      expect(calls.some((entry) => entry.args[0] === "push")).toBe(false);
      expect(provider.asked).toEqual(["authStatus", "canPush", "findProposal", "proposalStatus"]);
    });

    /**
     * A branch with no proposal is reported as having none.
     */
    it("should report a branch that has no proposal", async () => {
      await commitCurrentIndex();

      const result = await submit(new FakeProvider(), { statusOnly: true, branch: "nothing" });

      expect(result.outcome).toBe("status");
      expect(result.branch).toBe("nothing");
      expect(result.status).toBeUndefined();
    });
  });

  describe("--commit", () => {
    /**
     * With `--commit`, the uncommitted paths are listed, confirmed once and
     * committed with the title, the description and the changelog, in order.
     */
    it("should confirm and commit uncommitted changes", async () => {
      await commitCurrentIndex();
      publishUpstream();
      writeFile(repo, "recipes/core/example/skills/two.md", "second\n");
      const { questions, asked } = recordingQuestions();

      const result = await submit(new FakeProvider(), { commit: true, questions });

      expect(asked).toContain("confirmCommit");
      expect(result.committed).toEqual(["recipes/core/example/skills/two.md"]);
      const message = git(repo, "log", "-1", "--format=%B");
      expect(message).toMatch(/^Add a skill\n\nIt adds a skill\.\n\n## What merging this changes/);
      expect(message).toMatch(/core\/example.*its version is still 1\.0\.0/);
      expect(message).toContain("A release run with `--ci`");
      expect(git(repo, "status", "--porcelain")).toBe("");
    });

    /**
     * Declining the commit writes nothing.
     */
    it("should write nothing when the commit is declined", async () => {
      await commitCurrentIndex();
      writeFile(repo, "recipes/core/example/skills/two.md", "second\n");
      const { questions } = recordingQuestions({ confirmCommit: async () => false });

      const result = await submit(new FakeProvider(), { commit: true, questions });

      expect(result.outcome).toBe("cancelled");
      expect(git(repo, "status", "--porcelain")).toContain("two.md");
      expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    });

    /**
     * A missing git identity is reported before anything is written.
     */
    it("should report a missing identity before writing anything", async () => {
      await commitCurrentIndex();
      writeFile(repo, "recipes/core/example/skills/two.md", "second\n");
      noIdentity = true;

      await expect(submit(new FakeProvider(), { commit: true })).rejects.toThrow(
        /cannot work out who is committing/
      );
      expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    });

    /**
     * Without `--commit`, nothing is sent while the working tree has
     * uncommitted changes, and the message lists exactly what is outstanding.
     */
    it("should refuse while anything is uncommitted, listing what is", async () => {
      await commitCurrentIndex();
      writeFile(repo, "recipes/core/example/skills/two.md", "second\n");

      await expect(submit(new FakeProvider())).rejects.toThrow(/skills\/two\.md[\s\S]*--commit/);
    });
  });

  describe("recipes that take no proposals", () => {
    /** Marks the example recipe as taking no proposals, and publishes that upstream. */
    function declineProposals(): void {
      writeFile(
        repo,
        "recipes/core/example/sous.recipe.yaml",
        "formatVersion: 1\nnamespace: core\nname: example\nversion: 1.0.0\n" +
          "submissions:\n  allowed: false\n  instead: Propose it upstream.\n"
      );
      commitAll(repo, "decline proposals");
      publishUpstream();
      writeFile(repo, "recipes/core/example/skills/one.md", "edited\n");
      commitAll(repo, "edit a recipe that declines proposals");
    }

    /**
     * A change touching such a recipe is warned about, with where to go instead,
     * and proposed when the contributor carries on.
     */
    it("should warn, then propose when the contributor carries on", async () => {
      await commitCurrentIndex();
      declineProposals();
      const warnings: string[] = [];
      const { questions, asked } = recordingQuestions();

      const result = await submit(new FakeProvider(), {
        questions,
        onWarning: (message) => warnings.push(message),
      });

      expect(asked).toContain("proceedDespiteSubmissions");
      expect(warnings.join("\n")).toMatch(/core\/example[\s\S]*Instead: Propose it upstream\./);
      expect(result.outcome).toBe("created");
      expect(result.refusing.map((entry) => entry.key)).toEqual(["core/example"]);
    });

    /**
     * Declining sends nothing.
     */
    it("should send nothing when the contributor declines", async () => {
      await commitCurrentIndex();
      declineProposals();
      const { questions } = recordingQuestions({ proceedDespiteSubmissions: async () => false });

      const result = await submit(new FakeProvider(), { questions });

      expect(result.outcome).toBe("cancelled");
      expect(calls.some((entry) => entry.args[0] === "push")).toBe(false);
    });
  });

  describe("preflight", () => {
    /**
     * The provider is how the proposal is sent, so a provider that is not signed
     * in stops the run. The explanation is the provider's own, and the
     * repository's contribution pointer is added to it.
     */
    it("should stop with the provider's reason and the contribution pointer", async () => {
      await commitCurrentIndex();
      const provider = new FakeProvider({
        auth: { ok: false, detail: "The stand-in host CLI is not signed in." },
      });

      await expect(submit(provider)).rejects.toThrow(/not signed in/);
      await expect(submit(provider)).rejects.toThrow(/recipes@example\.com/);
    });

    /**
     * A provider that does not promise the submit feature is never asked to
     * carry a proposal, and the message points at the route the repository
     * documents instead.
     */
    it("should refuse a provider that does not promise to submit", async () => {
      await commitCurrentIndex();
      const provider = new FakeProvider({ features: ["fetch"] });

      await expect(submit(provider)).rejects.toThrow(/cannot propose a change on your behalf/);
      await expect(submit(provider)).rejects.toThrow(/recipes@example\.com/);
      expect(provider.asked).toEqual([]);
    });

    /**
     * The checkout `sous repo link` makes is shallow and holds almost none of the
     * tags. Whether the index agrees with the tags is the maintainer's check, so a
     * published version whose tag this checkout lacks does not stop a proposal.
     */
    it("should submit from a checkout that lacks the release tags", async () => {
      git(repo, "tag", "--annotate", "core/example@1.0.0", "--message", "release");
      await commitCurrentIndex();
      git(repo, "tag", "--delete", "core/example@1.0.0");

      const result = await submit(new FakeProvider());

      expect(result.url).toBe("https://github.com/owner/recipes/pull/7");
    });

    /**
     * The index is written by the repository's own release after a merge, so a
     * change that edits it is refused, naming the file and how to restore it.
     *
     * submit(provider);  // -> "This change edits sous.index.json. ..."
     */
    it("should refuse a change that edits the index", async () => {
      await commitCurrentIndex();
      publishUpstream();
      writeFile(repo, "sous.index.json", "{}\n");
      commitAll(repo, "edit the index by hand");

      await expect(submit(new FakeProvider())).rejects.toThrow(
        /This change edits sous\.index\.json/
      );
    });

    /**
     * With no copy of the upstream branch to compare with, the check cannot be
     * made, and the contributor is told so rather than left to assume it passed.
     */
    it("should say so when there is no upstream branch to compare with", async () => {
      await commitCurrentIndex();
      const notices: string[] = [];

      const result = await submit(new FakeProvider(), {
        onNotice: (message) => notices.push(message),
      });

      expect(notices.join("\n")).toMatch(/could not check whether sous\.index\.json was changed/);
      expect(result.changelog?.compared).toBe(false);
    });

    /**
     * A repository with no origin has nowhere to send a proposal, and the error
     * says how to give it one.
     */
    it("should refuse when the repository has no origin remote", async () => {
      await commitCurrentIndex();
      git(repo, "remote", "remove", "origin");

      await expect(submit(new FakeProvider())).rejects.toThrow(/no 'origin' remote/);
    });

    /**
     * A failure partway through says which steps completed, so a pushed branch
     * with no proposal behind it is never a silent surprise.
     */
    it("should report which steps completed when a step fails", async () => {
      await commitCurrentIndex();
      const provider = new FakeProvider({ proposeError: "the API rejected the request" });

      await expect(submit(provider)).rejects.toThrow(/What had already been done/);
      await expect(submit(provider)).rejects.toThrow(/Pushing 'sous\/submit-20260910-1403'/);
    });
  });

  describe("the changelog", () => {
    /**
     * The proposal's body lists what merging changes, compared with the default
     * branch: here a version raise and a new variable.
     */
    it("should describe a version raise and a new variable", async () => {
      await commitCurrentIndex();
      publishUpstream();
      writeFile(
        repo,
        "recipes/core/example/sous.recipe.yaml",
        "formatVersion: 1\nnamespace: core\nname: example\nversion: 1.1.0\n" +
          "variables:\n  - name: apiUrl\n    type: url\n    prompt: Which API?\n" +
          "    description: The API the skill calls.\n    example: https://example.com\n"
      );
      commitAll(repo, "raise the example recipe");
      const provider = new FakeProvider();

      await submit(provider);

      expect(provider.proposal?.body).toMatch(/`core\/example`: 1\.0\.0 becomes 1\.1\.0/);
      expect(provider.proposal?.body).toMatch(/the variable `apiUrl` was added/);
    });
  });
});
