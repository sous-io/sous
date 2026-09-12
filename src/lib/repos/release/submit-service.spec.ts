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
import { spawnCommand, type CommandRunner } from "../providers/git.js";
import {
  buildCanonicalRepo,
  splitRepoUrl,
  type AuthStatus,
  type CanonicalRepo,
  type ChangeProposal,
  type FetchedIndex,
  type ForkedRepo,
  type ProposedChange,
  type ProviderCli,
  type ProviderFeature,
  type ProviderOptions,
} from "../providers/provider.js";
import { submitRepo } from "./submit-service.js";
import { buildIndex, indexFilePath } from "./index-builder.js";
import { validateRepo } from "./validate.js";

let tmp: TmpDir;
let repo: string;
let calls: Array<{ command: string; args: string[] }>;

/** The sous version recorded when the index is regenerated for the check. */
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
  /** The features the provider declares. Defaults to fetch and submit. */
  features?: ProviderFeature[];
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

  constructor(private readonly answers: FakeAnswers = {}) {
    super();
    this.features = answers.features ?? ["fetch", "submit"];
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
}

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
    if (command === "git" && args[0] === "push") return { code: 0, stdout: "", stderr: "" };
    if (command === "git") return spawnCommand(command, args, options);
    throw new Error(
      `the sequencer spawned '${command}' itself; the provider owns every host command`
    );
  };
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

/** Runs a submission against the temporary repository, through one provider. */
async function submit(
  provider: FakeProvider,
  options: {
    dryRun?: boolean;
    title?: string;
    draft?: boolean;
    onNotice?: (message: string) => void;
  } = {}
) {
  return submitRepo({
    rootDir: repo,
    sousVersion: GENERATOR,
    run: makeRunner(),
    providers: [provider],
    now: new Date(2026, 8, 10, 14, 3),
    ...options,
  });
}

describe("submitRepo()", () => {
  /**
   * The whole path, for a contributor who can push to the repository itself: a
   * branch is made, pushed to origin, and the provider is handed a proposal
   * against the default branch with the title and body sous composed.
   */
  it("should branch, push to origin and ask the provider to propose the change", async () => {
    await commitCurrentIndex();
    const provider = new FakeProvider();

    const result = await submit(provider);

    expect(result.provider).toBe("github");
    expect(result.branch).toBe("sous/submit-20260910-1403");
    expect(result.usedFork).toBe(false);
    expect(result.pushedTo).toBe("origin");
    expect(result.url).toBe("https://github.com/owner/recipes/pull/7");
    expect(result.title).toBe("regenerate the index");

    expect(provider.asked).toEqual(["authStatus", "canPush", "proposeChange"]);
    expect(provider.proposal?.branch).toBe("sous/submit-20260910-1403");
    expect(provider.proposal?.head).toBeUndefined();
    expect(provider.proposal?.draft).toBe(false);
    expect(provider.proposal?.body).toMatch(/core\/example at version 1\.0\.0/);
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
   * Nothing is sent while the working tree has uncommitted changes, and the
   * message lists exactly what is outstanding.
   */
  it("should refuse while anything is uncommitted, listing what is", async () => {
    await commitCurrentIndex();
    writeFile(repo, "recipes/core/example/skills/two.md", "second\n");

    await expect(submit(new FakeProvider())).rejects.toThrow(/skills\/two\.md/);
  });

  /**
   * A proposal whose index is out of date would fail the maintainer's own
   * checks, so it is stopped here with the command that fixes it.
   */
  it("should refuse while the committed index is out of date", async () => {
    git(repo, "tag", "--annotate", "core/example@1.0.0", "--message", "release");

    await expect(submit(new FakeProvider())).rejects.toThrow(/Run 'sous repo release'/);
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
});
