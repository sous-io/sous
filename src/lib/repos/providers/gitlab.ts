/**
 * The GitLab provider: the read path, and as much of the write path as GitLab
 * honestly gives sous.
 *
 * The read shape is the same as the GitHub provider's: the index file is one raw
 * HTTPS GET, and a recipe's subtree comes from git. A token is used when one is
 * available, read from GITLAB_TOKEN or asked of the `glab` command line tool
 * when that is installed and signed in; a missing `glab` is never an error on
 * the read path.
 *
 * The write path is one merge request opened by `glab mr create`, from a branch
 * the contributor can already push. Sous does not fork on GitLab: there is no
 * fork-and-track flow here that sous can carry out without guessing, so
 * `canPush` answers "cannot tell" rather than inventing a permission, and `fork`
 * refuses with the manual route spelled out. Saying so is the point; pretending
 * otherwise would strand a contributor halfway through a submission.
 *
 * Self-hosted instances are supported: any host whose name begins with `gitlab.`
 * is recognized automatically, and a repository entry may always name its
 * provider outright for a host that gives nothing away.
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
  type ProposedChange,
  type ProviderCli,
  type ProviderFeature,
  type ProviderOptions,
} from "./provider.js";

/** The host this provider serves when a URL does not say otherwise. */
export const GITLAB_HOST = "gitlab.com";

/** The environment variable a GitLab token is read from. */
export const GITLAB_TOKEN_ENV = "GITLAB_TOKEN";

/**
 * Finds a GitLab token: the environment first, then `glab auth token` when the
 * `glab` command line tool is installed and signed in. Returns undefined when
 * there is none, because public repositories need no token at all.
 *
 * @param options - Environment and subprocess runner overrides.
 */
export async function findGitlabToken(options: {
  env?: NodeJS.ProcessEnv;
  run?: CommandRunner;
} = {}): Promise<string | undefined> {
  return new GitlabProvider().token(options);
}

/** The GitLab provider. */
export class GitlabProvider extends ProviderBase {
  readonly id = "gitlab" as const;

  /**
   * Reads the index and recipe subtrees, and proposes a change through
   * the GitLab CLI ('glab').
   */
  readonly features: ProviderFeature[] = ["fetch", "submit"];

  /** The command line tool the write path is built on. */
  readonly cli: ProviderCli = {
    command: "glab",
    label: "the GitLab CLI",
    install: "https://gitlab.com/gitlab-org/cli",
  };

  /** What GitLab calls a proposal. */
  readonly proposalNoun = "merge request";

  matches(url: string): boolean {
    const parts = splitRepoUrl(url);
    if (parts === undefined) return false;
    return parts.host === GITLAB_HOST || parts.host.startsWith("gitlab.");
  }

  canonicalize(url: string): CanonicalRepo {
    const parts = splitRepoUrl(url);
    if (parts === undefined) throw invalidRepoUrl(this.id, url);
    return buildCanonicalRepo(parts.host, parts.owner, parts.name);
  }

  /**
   * A GitLab token, from the environment or from `glab`.
   *
   * @param options - Environment and subprocess runner overrides.
   */
  async token(options: ProviderOptions = {}): Promise<string | undefined> {
    return this.findToken(GITLAB_TOKEN_ENV, ["auth", "token"], options);
  }

  /**
   * Fetches the repo's index file from the instance's raw file endpoint at the
   * repository's default branch.
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
    return `https://${repo.host}/${repo.owner}/${repo.name}/-/raw/HEAD/${INDEX_FILENAME}`;
  }

  // --- The write path --------------------------------------------------------

  /**
   * Whether `glab` is installed and signed in.
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
   * Always undefined: sous has no cheap, reliable way to ask GitLab whether the
   * contributor may push, and guessing would send them down a fork path this
   * provider cannot finish.
   *
   * @param _repo - The canonicalized repository; unused.
   * @param _options - Unused, because nothing is run.
   */
  async canPush(
    _repo: CanonicalRepo,
    _options: ProviderOptions = {}
  ): Promise<boolean | undefined> {
    return undefined;
  }

  /**
   * Refuses, with the manual route. Sous opens a merge request from a branch
   * the contributor can already push; forking on their behalf is not something
   * this provider does.
   *
   * @param repo - The canonicalized repository.
   */
  async fork(repo: CanonicalRepo): Promise<ForkedRepo> {
    throw new ConfigError(
      `Sous does not fork ${repo.owner}/${repo.name} for you on ${this.cli.label}; it opens a ` +
        `${this.proposalNoun} from a branch you can already push.\n` +
        `  Fork the project yourself, push your branch to the fork, then open the ` +
        `${this.proposalNoun} from there.`
    );
  }

  /**
   * Opens a merge request from the branch in the checkout the command is run
   * in, which is why the working directory matters here.
   *
   * @param _repo - The canonicalized repository; `glab` reads the checkout instead.
   * @param proposal - The branch, the text and whether it is a draft.
   * @param options - Subprocess runner and working directory overrides.
   */
  async proposeChange(
    _repo: CanonicalRepo,
    proposal: ChangeProposal,
    options: ProviderOptions = {}
  ): Promise<ProposedChange> {
    const args = ["mr", "create", "--source-branch", proposal.branch];
    if (proposal.base !== undefined) args.push("--target-branch", proposal.base);
    args.push(
      "--title",
      proposal.title,
      "--description",
      proposal.body,
      "--yes"
    );
    if (proposal.draft) args.push("--draft");

    const result = await this.runCommand(this.cli.command, args, options);
    if (result.code !== 0) {
      const reported = result.stderr.trim() || result.stdout.trim();
      throw new ConfigError(
        `'${this.cli.command} mr create' did not succeed, so no proposal was opened.` +
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
}
