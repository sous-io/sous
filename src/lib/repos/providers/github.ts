/**
 * The GitHub provider: the read path, and the write path behind it.
 *
 * Reading a repo needs no GitHub API and no `gh`: the index file is one raw
 * HTTPS GET, and a recipe's subtree comes from git itself. A token is used when
 * one is available, so private repositories work; it is read from GITHUB_TOKEN,
 * or asked of the `gh` command line tool when that is installed and signed in.
 * A missing `gh` is never an error on the read path.
 *
 * The write path is where `gh` becomes load-bearing, and this file is the ONLY
 * place in sous that knows the command exists. Proposing a change is a pull
 * request opened by `gh pr create`, a contributor without push permission works
 * through a fork made by `gh repo fork`, and both are reported back as plain
 * data, so the service that sequences them never learns a GitHub-shaped fact.
 * Finding a pull request again, reporting where it stands and replacing its
 * text go through `gh pr list`, `gh pr view` and `gh pr edit` the same way.
 */

import { ConfigError } from "../../errors.js";
import { INDEX_FILENAME } from "../formats/common.js";
import { ProviderBase, firstUrlIn } from "./base.js";
import { fetchSubtree, type CommandRunner } from "./git.js";
import { fetchText, type FetchLike } from "./http.js";
import {
  buildCanonicalRepo,
  invalidRepoUrl,
  splitRepoUrl,
  type AuthStatus,
  type CanonicalRepo,
  type ChangeProposal,
  type FetchedIndex,
  type ForkedRepo,
  type ProposalChecks,
  type ProposalQuery,
  type ProposalReview,
  type ProposalState,
  type ProposalStatus,
  type ProposalSummary,
  type ProposalUpdate,
  type ProposedChange,
  type ProviderCli,
  type ProviderFeature,
  type ProviderOptions,
} from "./provider.js";

/** The host this provider serves when a URL does not say otherwise. */
export const GITHUB_HOST = "github.com";

/** The environment variable a GitHub token is read from. */
export const GITHUB_TOKEN_ENV = "GITHUB_TOKEN";

/**
 * Finds a GitHub token: the environment first, then `gh auth token` when the
 * `gh` command line tool is installed and signed in. Returns undefined when
 * there is none, because public repositories need no token at all.
 *
 * @param options - Environment and subprocess runner overrides.
 */
export async function findGithubToken(options: {
  env?: NodeJS.ProcessEnv;
  run?: CommandRunner;
} = {}): Promise<string | undefined> {
  return new GithubProvider().token(options);
}

/** The GitHub provider. */
export class GithubProvider extends ProviderBase {
  readonly id = "github" as const;

  /**
   * Reads the index and recipe subtrees, proposes a change through the GitHub
   * CLI ('gh'), and finds, reports on and updates that pull request afterwards.
   */
  readonly features: ProviderFeature[] = ["fetch", "submit", "proposals"];

  /** The command line tool the write path is built on. */
  readonly cli: ProviderCli = {
    command: "gh",
    label: "the GitHub CLI",
    install: "https://cli.github.com",
  };

  /** What GitHub calls a proposal. */
  readonly proposalNoun = "pull request";

  matches(url: string): boolean {
    const parts = splitRepoUrl(url);
    return parts !== undefined && parts.host === GITHUB_HOST;
  }

  canonicalize(url: string): CanonicalRepo {
    const parts = splitRepoUrl(url);
    if (parts === undefined) throw invalidRepoUrl(this.id, url);
    return buildCanonicalRepo(parts.host, parts.owner, parts.name);
  }

  /**
   * A GitHub token, from the environment or from `gh`. Public, because the
   * index cache and the exported `findGithubToken` both ask for one.
   *
   * @param options - Environment and subprocess runner overrides.
   */
  async token(options: ProviderOptions = {}): Promise<string | undefined> {
    return this.findToken(GITHUB_TOKEN_ENV, ["auth", "token"], options);
  }

  /**
   * Fetches the repo's index file from the raw content host at the repository's
   * default branch, which is what `HEAD` names there.
   *
   * @param repo - The canonicalized repository.
   * @param options - Environment, fetch and subprocess overrides.
   */
  async fetchIndex(
    repo: CanonicalRepo,
    options: ProviderOptions = {}
  ): Promise<FetchedIndex> {
    const token = await this.token(options);
    const url = this.indexUrl(repo);
    const fetched = await fetchText(url, {
      ...(token === undefined ? {} : { token }),
      ...(options.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.fetchImpl as FetchLike }),
      label: "repo index",
    });

    return fetched.etag === undefined
      ? { text: fetched.text, ref: "HEAD" }
      : { text: fetched.text, ref: "HEAD", etag: fetched.etag };
  }

  /**
   * Fetches one recipe folder at one tag. Private repositories work through
   * git's own credential helpers, the same way a manual clone would.
   *
   * @param repo - The canonicalized repository.
   * @param recipePath - The recipe folder, relative to the repository root.
   * @param tag - The git tag carrying the version.
   * @param destDir - Where the recipe's files should end up.
   * @param options - Subprocess runner override.
   */
  async fetchRecipeTree(
    repo: CanonicalRepo,
    recipePath: string,
    tag: string,
    destDir: string,
    options: ProviderOptions = {}
  ): Promise<void> {
    await fetchSubtree({
      cloneUrl: repo.httpsUrl,
      tag,
      subPath: recipePath,
      destDir,
      ...(options.run === undefined ? {} : { run: options.run }),
    });
  }

  /**
   * The raw URL of a repository's index file at its default branch.
   *
   * @param repo - The canonicalized repository.
   */
  indexUrl(repo: CanonicalRepo): string {
    return `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/HEAD/${INDEX_FILENAME}`;
  }

  // --- The write path --------------------------------------------------------

  /**
   * Whether `gh` is installed and signed in. The detail is the whole
   * explanation, ready to print, because only this provider knows what to
   * install and which command signs in.
   *
   * @param options - Subprocess runner and working directory overrides.
   */
  async authStatus(options: ProviderOptions = {}): Promise<AuthStatus> {
    const ok = await this.commandSucceeds(this.cli.command, ["auth", "status"], options);
    if (ok) {
      return {
        ok: true,
        detail: `${this.cli.label} ('${this.cli.command}') is installed and signed in.`,
      };
    }
    return {
      ok: false,
      detail:
        `Sous proposes a change through ${this.cli.label} ('${this.cli.command}'), and it is ` +
        `either not installed or not signed in.\n` +
        `  Install it from ${this.cli.install}, then run '${this.cli.command} auth login'.`,
    };
  }

  /**
   * Whether the signed-in contributor may push to the repository itself, as
   * GitHub reports it. Undefined when `gh` could not answer at all, which is
   * not the same as a refusal.
   *
   * @param repo - The canonicalized repository.
   * @param options - Subprocess runner and working directory overrides.
   */
  async canPush(
    repo: CanonicalRepo,
    options: ProviderOptions = {}
  ): Promise<boolean | undefined> {
    const answer = await this.capturedOutput(
      this.cli.command,
      ["api", `repos/${repo.owner}/${repo.name}`, "--jq", ".permissions.push"],
      options
    );
    if (answer === undefined) return undefined;
    const value = answer.trim();
    if (value === "true") return true;
    if (value === "false") return false;
    return undefined;
  }

  /**
   * Forks the repository onto the contributor's own account and says where the
   * fork landed. No remote is added here; that is git's business, and the
   * service above does it with the URLs returned.
   *
   * @param repo - The canonicalized repository.
   * @param options - Subprocess runner and working directory overrides.
   */
  async fork(repo: CanonicalRepo, options: ProviderOptions = {}): Promise<ForkedRepo> {
    const forked = await this.runCommand(
      this.cli.command,
      ["repo", "fork", `${repo.owner}/${repo.name}`, "--remote=false"],
      options
    );
    if (forked.code !== 0) {
      throw new ConfigError(
        `'${this.cli.command} repo fork' did not succeed.\n  ` +
          `${forked.stderr.trim() || forked.stdout.trim()}`
      );
    }

    const who = await this.capturedOutput(
      this.cli.command,
      ["api", "user", "--jq", ".login"],
      options
    );
    if (who === undefined) {
      throw new ConfigError(
        "The fork was requested, but sous could not read your GitHub login from " +
          `'${this.cli.command} api user', so it does not know where the fork lives.`
      );
    }

    const owner = who.trim();
    return {
      owner,
      name: repo.name,
      httpsUrl: `https://${repo.host}/${owner}/${repo.name}.git`,
      sshUrl: `git@${repo.host}:${owner}/${repo.name}.git`,
    };
  }

  /**
   * Opens a pull request for a branch that has already been pushed. A proposal
   * carrying a head owner came from a fork, which is what a cross-repository
   * pull request spells as `owner:branch`.
   *
   * @param repo - The canonicalized repository the proposal targets.
   * @param proposal - The branch, the text and whether it is a draft.
   * @param options - Subprocess runner and working directory overrides.
   */
  async proposeChange(
    repo: CanonicalRepo,
    proposal: ChangeProposal,
    options: ProviderOptions = {}
  ): Promise<ProposedChange> {
    const head =
      proposal.head === undefined
        ? proposal.branch
        : `${proposal.head.owner}:${proposal.branch}`;

    const args = ["pr", "create", "--repo", `${repo.owner}/${repo.name}`];
    if (proposal.base !== undefined) args.push("--base", proposal.base);
    args.push("--head", head, "--title", proposal.title, "--body", proposal.body);
    if (proposal.draft) args.push("--draft");

    const result = await this.runCommand(this.cli.command, args, options);
    if (result.code !== 0) {
      const reported = result.stderr.trim() || result.stdout.trim();
      throw new ConfigError(
        `'${this.cli.command} pr create' did not succeed, so no proposal was opened.` +
          (reported.length === 0 ? "" : `\n  ${reported}`)
      );
    }

    const url = firstUrlIn(result.stdout);
    if (url === undefined) {
      return {
        detail:
          `The ${this.proposalNoun} was opened, but '${this.cli.command}' printed no address ` +
          `for it.`,
      };
    }
    return { url, detail: `The ${this.proposalNoun} is at ${url}.` };
  }

  // --- Proposals after the fact ------------------------------------------------

  /**
   * The pull request a branch was pushed for. GitHub lists pull requests by
   * head branch name alone, so the list is narrowed here by where the branch
   * lives: the repository itself, or the contributor's fork. When a branch has
   * had several, the open one wins, and otherwise the newest.
   *
   * @param repo - The canonicalized repository the proposal targets.
   * @param query - The branch, and whether it lives on a fork.
   * @param options - Subprocess runner and working directory overrides.
   */
  async findProposal(
    repo: CanonicalRepo,
    query: ProposalQuery,
    options: ProviderOptions = {}
  ): Promise<ProposalSummary | undefined> {
    const forkOwner = query.fromFork
      ? (query.forkOwner ?? (await this.signedInLogin(options)))
      : undefined;

    const listed = await this.ghJson<GhPullRequest[]>(
      [
        "pr",
        "list",
        "--repo",
        `${repo.owner}/${repo.name}`,
        "--head",
        query.branch,
        "--state",
        "all",
        "--limit",
        "50",
        "--json",
        "number,url,state,title,isDraft,baseRefName,headRepositoryOwner,isCrossRepository",
      ],
      "pr list",
      options
    );

    const mine = listed.filter((entry) =>
      query.fromFork
        ? entry.isCrossRepository === true && entry.headRepositoryOwner?.login === forkOwner
        : entry.isCrossRepository !== true
    );
    if (mine.length === 0) return undefined;

    const open = mine.find((entry) => entry.state === "OPEN");
    const chosen = open ?? [...mine].sort((a, b) => b.number - a.number)[0]!;
    return summarizePullRequest(chosen);
  }

  /**
   * Where one pull request stands: its state, its review decision, and how
   * its checks are going, counted.
   *
   * @param repo - The canonicalized repository the proposal targets.
   * @param id - The pull request number.
   * @param options - Subprocess runner and working directory overrides.
   */
  async proposalStatus(
    repo: CanonicalRepo,
    id: string,
    options: ProviderOptions = {}
  ): Promise<ProposalStatus> {
    const viewed = await this.ghJson<GhPullRequest>(
      [
        "pr",
        "view",
        id,
        "--repo",
        `${repo.owner}/${repo.name}`,
        "--json",
        "number,url,state,title,isDraft,baseRefName,reviewDecision,statusCheckRollup,mergeable",
      ],
      "pr view",
      options
    );

    const review = reviewFrom(viewed.reviewDecision);
    const checks = checksFrom(viewed.statusCheckRollup);
    const mergeable =
      viewed.mergeable === "MERGEABLE"
        ? true
        : viewed.mergeable === "CONFLICTING"
          ? false
          : undefined;

    return {
      proposal: summarizePullRequest(viewed),
      ...(review === undefined ? {} : { review }),
      ...(checks === undefined ? {} : { checks }),
      ...(mergeable === undefined ? {} : { mergeable }),
    };
  }

  /**
   * Replaces a pull request's title, its body, or both.
   *
   * @param repo - The canonicalized repository the proposal targets.
   * @param id - The pull request number.
   * @param update - What to replace.
   * @param options - Subprocess runner and working directory overrides.
   */
  async updateProposal(
    repo: CanonicalRepo,
    id: string,
    update: ProposalUpdate,
    options: ProviderOptions = {}
  ): Promise<ProposedChange> {
    const args = ["pr", "edit", id, "--repo", `${repo.owner}/${repo.name}`];
    if (update.title !== undefined) args.push("--title", update.title);
    if (update.body !== undefined) args.push("--body", update.body);

    const result = await this.runCommand(this.cli.command, args, options);
    if (result.code !== 0) {
      const reported = result.stderr.trim() || result.stdout.trim();
      throw new ConfigError(
        `'${this.cli.command} pr edit' did not succeed, so the ${this.proposalNoun} kept its ` +
          `title and body.` +
          (reported.length === 0 ? "" : `\n  ${reported}`)
      );
    }

    const url = firstUrlIn(result.stdout);
    return url === undefined
      ? { detail: `The ${this.proposalNoun} was updated.` }
      : { url, detail: `The ${this.proposalNoun} at ${url} was updated.` };
  }

  /**
   * The login of the account `gh` is signed in as, which is the owner of any
   * fork sous made for the contributor.
   *
   * @param options - Subprocess runner and working directory overrides.
   */
  private async signedInLogin(options: ProviderOptions): Promise<string> {
    const who = await this.capturedOutput(
      this.cli.command,
      ["api", "user", "--jq", ".login"],
      options
    );
    if (who === undefined || who.trim().length === 0) {
      throw new ConfigError(
        "Sous could not read your GitHub login from " +
          `'${this.cli.command} api user', so it cannot tell which fork a ${this.proposalNoun} ` +
          "would come from."
      );
    }
    return who.trim();
  }

  /**
   * Runs a `gh` command that prints JSON, and parses what it printed.
   *
   * @param args - The arguments, ending with the `--json` field list.
   * @param what - The subcommand, as it is named in a failure.
   * @param options - Subprocess runner and working directory overrides.
   */
  private async ghJson<T>(args: string[], what: string, options: ProviderOptions): Promise<T> {
    const result = await this.runCommand(this.cli.command, args, options);
    if (result.code !== 0) {
      const reported = result.stderr.trim() || result.stdout.trim();
      throw new ConfigError(
        `'${this.cli.command} ${what}' did not succeed.` +
          (reported.length === 0 ? "" : `\n  ${reported}`)
      );
    }
    try {
      return JSON.parse(result.stdout) as T;
    } catch {
      throw new ConfigError(
        `'${this.cli.command} ${what}' printed something that is not JSON, so sous cannot read ` +
          `the ${this.proposalNoun} it describes.`
      );
    }
  }
}

// --- What gh prints, and how it maps onto plain data ---------------------------------------------

/** The fields sous asks `gh` for, as it prints them. */
type GhPullRequest = {
  number: number;
  url?: string;
  state?: string;
  title?: string;
  isDraft?: boolean;
  baseRefName?: string;
  headRepositoryOwner?: { login?: string } | null;
  isCrossRepository?: boolean;
  reviewDecision?: string | null;
  statusCheckRollup?: GhCheck[] | null;
  mergeable?: string;
};

/** One entry of a pull request's status check rollup: a check run or a commit status. */
type GhCheck = {
  __typename?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
};

/** A pull request's state, in the words every provider shares. */
function stateFrom(state: string | undefined): ProposalState {
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return "open";
}

/**
 * The plain summary of a pull request.
 *
 * @param entry - What `gh` printed for it.
 */
function summarizePullRequest(entry: GhPullRequest): ProposalSummary {
  return {
    id: String(entry.number),
    ...(entry.url === undefined ? {} : { url: entry.url }),
    state: stateFrom(entry.state),
    title: entry.title ?? "",
    draft: entry.isDraft === true,
    ...(entry.baseRefName === undefined ? {} : { base: entry.baseRefName }),
  };
}

/** GitHub's review decision, in the words every provider shares. */
function reviewFrom(decision: string | null | undefined): ProposalReview | undefined {
  if (decision === "APPROVED") return "approved";
  if (decision === "CHANGES_REQUESTED") return "changes requested";
  if (decision === "REVIEW_REQUIRED") return "review required";
  return undefined;
}

/** Check runs whose conclusion counts as passing. */
const PASSING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * Counts a status check rollup into passed, failed and pending. A check run
 * that has not completed is pending; a commit status reports its state directly.
 *
 * @param rollup - What `gh` printed as the rollup, when it printed one.
 */
function checksFrom(rollup: GhCheck[] | null | undefined): ProposalChecks | undefined {
  if (rollup === null || rollup === undefined || rollup.length === 0) return undefined;
  const counts: ProposalChecks = { passed: 0, failed: 0, pending: 0 };
  for (const check of rollup) {
    const isStatus =
      check.__typename === "StatusContext" ||
      (check.status === undefined && check.state !== undefined);
    if (isStatus) {
      if (check.state === "SUCCESS") counts.passed += 1;
      else if (check.state === "PENDING" || check.state === "EXPECTED") counts.pending += 1;
      else counts.failed += 1;
      continue;
    }
    if (check.status !== "COMPLETED") counts.pending += 1;
    else if (PASSING_CONCLUSIONS.has(check.conclusion ?? "")) counts.passed += 1;
    else counts.failed += 1;
  }
  return counts;
}
