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
   * Reads the index and recipe subtrees, and proposes a change through
   * the GitHub CLI ('gh').
   */
  readonly features: ProviderFeature[] = ["fetch", "submit"];

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
}
