/**
 * Proposing a change to a recipe repository: validate first, then delegate.
 *
 * `submit` universally means "propose a change for maintainers to review". It
 * never publishes and never writes to a repository directly; the fork, branch
 * and pull request mechanics are handed to the provider's own CLI (`gh` or
 * `glab`), which already holds the contributor's credentials.
 *
 * Two rules shape everything here:
 *
 * - Nothing is sent until the repository validates and its index is current. A
 *   proposal that fails the maintainer's own checks wastes their review.
 * - Every step announces itself BEFORE it runs, and a failure says exactly which
 *   steps completed. A half-finished submission (a branch pushed, no pull
 *   request opened) is a normal outcome of a network failure, and the
 *   contributor has to be told the truth about it.
 *
 * Every subprocess goes through the injectable runner, so no test here reaches
 * a network.
 */

import { ConfigError } from "../../errors.js";
import { spawnCommand, type CommandRunner } from "../providers/git.js";
import { detectProvider } from "../providers/index.js";
import type { CanonicalRepo, RepoProvider } from "../providers/provider.js";
import {
  buildIndex,
  describeIndexDrift,
  readIndexFile,
  type IndexBuildResult,
} from "./index-builder.js";
import {
  currentBranch,
  createBranch,
  defaultBranch,
  lastCommitSubject,
  pushBranch,
  remoteUrl,
  submitBranchName,
  uncommittedChanges,
} from "./git-state.js";
import {
  errorsIn,
  hasErrors,
  validateRepo,
  type RepoValidation,
  type ValidationProblem,
} from "./validate.js";

/** The remote a repository is contributed back to. */
const UPSTREAM_REMOTE = "origin";

/** The remote name sous gives a fork it created. */
const FORK_REMOTE = "fork";

/** What one provider's command line tool is called and how it is driven. */
type ProviderCli = {
  /** The executable. */
  command: string;
  /** Plain-language name, for messages. */
  label: string;
  /** Where to get it, for the message that says it is missing. */
  install: string;
};

/** The command line tool each provider delegates its write path to. */
const PROVIDER_CLIS: Record<string, ProviderCli> = {
  github: { command: "gh", label: "the GitHub CLI", install: "https://cli.github.com" },
  gitlab: { command: "glab", label: "the GitLab CLI", install: "https://gitlab.com/gitlab-org/cli" },
};

/** What `submitRepo` needs to know. */
export type SubmitOptions = {
  /** The repository's root directory. */
  rootDir: string;
  /** The title for the proposal. Defaults to the last commit's subject. */
  title?: string;
  /** The body for the proposal. Defaults to a summary sous writes. */
  body?: string;
  /** Whether to open the proposal as a draft. */
  draft?: boolean;
  /** When true, everything is checked and reported and nothing is sent. */
  dryRun?: boolean;
  /** The version of sous, recorded when the index is regenerated for the check. */
  sousVersion: string;
  /** When the submission is happening; decides the branch name. Defaults to now. */
  now?: Date;
  /** How subprocesses are run. Defaults to spawning a real process. */
  run?: CommandRunner;
  /** The providers to consider. Defaults to the built-in list. */
  providers?: RepoProvider[];
  /** Called with each step, BEFORE it runs. */
  onStep?: (message: string) => void;
  /** Called with anything worth saying that is not a step. */
  onNotice?: (message: string) => void;
};

/** What a submission did. */
export type SubmitResult = {
  /** The provider the proposal went to. */
  provider: string;
  /** The repository, as the provider understands it. */
  repo: CanonicalRepo;
  /** The branch the change is on. */
  branch: string;
  /** The branch the proposal targets. */
  baseBranch: string;
  /** True when the change was pushed to a fork rather than to the repository itself. */
  usedFork: boolean;
  /** The remote the branch was pushed to. */
  pushedTo: string;
  /** The proposal's title. */
  title: string;
  /** The proposal's URL, when the provider's CLI printed one. */
  url?: string;
  /** Every step that completed, in order. */
  completed: string[];
  /** True when nothing was actually sent. */
  dryRun: boolean;
};

/**
 * Validates a repository and proposes its committed changes upstream.
 *
 * @param options - The repository, the proposal's text, and the testing seams.
 */
export async function submitRepo(options: SubmitOptions): Promise<SubmitResult> {
  const {
    rootDir,
    sousVersion,
    draft = false,
    dryRun = false,
    now = new Date(),
    run = spawnCommand,
  } = options;
  const step = options.onStep ?? (() => {});
  const notice = options.onNotice ?? (() => {});
  const completed: string[] = [];

  /** Runs one step, announcing it first and recording it once it succeeds. */
  const doStep = async <T>(message: string, action: () => Promise<T>): Promise<T> => {
    step(message);
    const result = await action().catch((error: unknown) => {
      throw partialStateError(message, completed, error);
    });
    completed.push(message);
    return result;
  };

  // --- Preflight: is this a repository sous can propose a change to? --------

  step("Reading the repository manifest and every recipe in it");
  const validation = validateRepo(rootDir);
  assertRepoValidates(validation);
  completed.push("Read the repository manifest and every recipe in it");

  step("Confirming the committed index is current");
  const built = await buildIndex({
    validation,
    existing: readIndexFile(rootDir),
    sousVersion,
    run,
  });
  assertIndexReady(built, readIndexFile(rootDir));
  completed.push("Confirmed the committed index is current");

  step("Looking up where this repository was cloned from");
  const upstreamUrl = await remoteUrl(rootDir, UPSTREAM_REMOTE, { run });
  if (upstreamUrl === undefined) {
    throw new ConfigError(
      `This repository has no '${UPSTREAM_REMOTE}' remote, so sous cannot tell where to ` +
        `propose the change.\n` +
        `  Add one with 'git remote add ${UPSTREAM_REMOTE} <url>', then run the command again.`
    );
  }
  completed.push("Looked up where this repository was cloned from");

  const provider = requireSubmitProvider(upstreamUrl, validation, options.providers);
  const cli = PROVIDER_CLIS[provider.id]!;
  const repo = provider.canonicalize(upstreamUrl);

  step(`Checking that ${cli.label} is installed and signed in`);
  if (!(await commandSucceeds(run, cli.command, ["auth", "status"]))) {
    throw new ConfigError(
      `Sous proposes a change through ${cli.label} ('${cli.command}'), and it is either not ` +
        `installed or not signed in.\n` +
        `  Install it from ${cli.install}, then run '${cli.command} auth login'.\n` +
        contributePointer(validation)
    );
  }
  completed.push(`Checked that ${cli.label} is installed and signed in`);

  step("Checking that everything is committed");
  const changed = await uncommittedChanges(rootDir, { run });
  if (changed.length > 0) {
    const listed = changed.map((entry) => `    ${entry.path}`).join("\n");
    throw new ConfigError(
      "Cannot propose a change while the working tree has uncommitted changes.\n\n" +
        `${listed}\n\n` +
        "  A proposal is made of commits, so everything it should carry has to be " +
        "committed first.\n" +
        "  Sous does not commit for you: commit these, then run the command again."
    );
  }
  completed.push("Checked that everything is committed");

  // --- The branch the change lives on ---------------------------------------

  const baseBranch = (await defaultBranch(rootDir, { run })) ?? "main";
  const checkedOut = await currentBranch(rootDir, { run });
  let branch = checkedOut;

  if (checkedOut === undefined || checkedOut === baseBranch) {
    branch = submitBranchName(now);
    if (dryRun) {
      notice(`A branch named '${branch}' would be created from the current commit.`);
    } else {
      await doStep(`Creating the branch '${branch}' from the current commit`, () =>
        createBranch(rootDir, branch!, { run })
      );
    }
  }

  const title =
    options.title ?? (await lastCommitSubject(rootDir, { run })) ?? defaultTitle(validation);
  const body = options.body ?? defaultBody(built, validation);

  // --- Fork, push, propose --------------------------------------------------

  let usedFork = false;
  let pushRemote = UPSTREAM_REMOTE;
  let head = branch!;

  if (provider.id === "github") {
    step("Checking whether you can push to the repository itself");
    const canPush = await capturedOutput(run, "gh", [
      "api",
      `repos/${repo.owner}/${repo.name}`,
      "--jq",
      ".permissions.push",
    ]);
    completed.push("Checked whether you can push to the repository itself");

    if (canPush?.trim() !== "true") {
      usedFork = true;
      pushRemote = FORK_REMOTE;
      if (dryRun) {
        notice(
          `You cannot push to ${repo.owner}/${repo.name}, so the change would go through ` +
            `a fork on your own account.`
        );
      } else {
        head = await prepareFork(rootDir, repo, branch!, run, doStep);
      }
    }
  }

  if (dryRun) {
    notice("Nothing was sent; this was a dry run.");
    return {
      provider: provider.id,
      repo,
      branch: branch!,
      baseBranch,
      usedFork,
      pushedTo: pushRemote,
      title,
      completed,
      dryRun: true,
    };
  }

  await doStep(`Pushing '${branch}' to '${pushRemote}'`, () =>
    pushBranch(rootDir, pushRemote, branch!, { run })
  );

  const url = await doStep(
    provider.id === "gitlab"
      ? "Opening a merge request for review"
      : "Opening a pull request for review",
    async () => {
      const args =
        provider.id === "gitlab"
          ? gitlabArgs(branch!, baseBranch, title, body, draft)
          : githubArgs(repo, head, baseBranch, title, body, draft);
      const output = await capturedOutput(run, cli.command, args, rootDir);
      if (output === undefined) {
        throw new ConfigError(
          `'${cli.command} ${args[0]} ${args[1]}' did not succeed, so no proposal was opened.`
        );
      }
      return firstUrlIn(output);
    }
  );

  return {
    provider: provider.id,
    repo,
    branch: branch!,
    baseBranch,
    usedFork,
    pushedTo: pushRemote,
    title,
    url,
    completed,
    dryRun: false,
  };
}

// --- Preflight helpers --------------------------------------------------------------------------

/** Refuses to submit a repository that does not describe itself correctly. */
function assertRepoValidates(validation: RepoValidation): void {
  if (!hasErrors(validation.problems)) return;
  throw new ConfigError(
    "This repository does not validate, so there is nothing worth proposing yet:\n\n" +
      renderProblems(errorsIn(validation.problems)) +
      "\n\n  Fix these, then run the command again."
  );
}

/** Refuses to submit while the index disagrees with what the repository publishes. */
function assertIndexReady(
  built: IndexBuildResult,
  existing: ReturnType<typeof readIndexFile>
): void {
  if (hasErrors(built.problems)) {
    throw new ConfigError(
      "This repository's index and its tags do not agree, so there is nothing worth " +
        "proposing yet:\n\n" +
        renderProblems(errorsIn(built.problems)) +
        "\n\n  Fix these, then run the command again."
    );
  }

  if (built.stale) {
    const drift = describeIndexDrift(existing, built.index)
      .map((line) => `    ${line}`)
      .join("\n");
    throw new ConfigError(
      "The committed index is out of date, and a maintainer's own checks would reject " +
        "the proposal:\n\n" +
        `${drift}\n\n` +
        "  Run 'sous repo release', commit the regenerated index, then run this command " +
        "again."
    );
  }
}

/** Renders a list of problems as an indented block. */
function renderProblems(problems: ReadonlyArray<ValidationProblem>): string {
  return problems.map((problem) => `    ${problem.where}: ${problem.message}`).join("\n");
}

/**
 * The provider that will carry the proposal, or a ConfigError pointing the
 * contributor at whatever route the repository documents instead.
 */
function requireSubmitProvider(
  upstreamUrl: string,
  validation: RepoValidation,
  providers?: RepoProvider[]
): RepoProvider {
  const provider =
    providers === undefined ? detectProvider(upstreamUrl) : detectProvider(upstreamUrl, providers);

  if (provider === undefined) {
    throw new ConfigError(
      `Sous does not know how to propose a change to ${upstreamUrl}.\n` +
        contributePointer(validation)
    );
  }
  if (!provider.features.includes("submit") || PROVIDER_CLIS[provider.id] === undefined) {
    throw new ConfigError(
      `The '${provider.id}' provider cannot propose a change on your behalf.\n` +
        contributePointer(validation)
    );
  }
  return provider;
}

/** The repository's own contribution instructions, when its manifest carries any. */
function contributePointer(validation: RepoValidation): string {
  const contribute = validation.manifest.contribute;
  if (contribute === undefined) {
    return (
      `  This repository's manifest does not say where to send a change, so send it the ` +
      `way its maintainers prefer.`
    );
  }
  return `  This repository asks that changes be sent this way:\n    ${contribute}`;
}

// --- Delegation helpers -------------------------------------------------------------------------

/**
 * Forks the repository onto the contributor's own account, makes sure a remote
 * points at the fork, and returns the `owner:branch` reference a pull request
 * needs for a cross-repository head.
 */
async function prepareFork(
  rootDir: string,
  repo: CanonicalRepo,
  branch: string,
  run: CommandRunner,
  doStep: <T>(message: string, action: () => Promise<T>) => Promise<T>
): Promise<string> {
  const login = await doStep(
    `Forking ${repo.owner}/${repo.name} onto your own account`,
    async () => {
      const forked = await run(
        "gh",
        ["repo", "fork", `${repo.owner}/${repo.name}`, "--remote=false"],
        { cwd: rootDir }
      );
      if (forked.code !== 0) {
        throw new ConfigError(
          `'gh repo fork' did not succeed.\n  ${forked.stderr.trim() || forked.stdout.trim()}`
        );
      }
      const who = await capturedOutput(run, "gh", ["api", "user", "--jq", ".login"], rootDir);
      if (who === undefined) {
        throw new ConfigError(
          "The fork was requested, but sous could not read your GitHub login from " +
            "'gh api user', so it does not know where the fork lives."
        );
      }
      return who.trim();
    }
  );

  const forkUrl = `https://${repo.host}/${login}/${repo.name}.git`;
  const existing = await remoteUrl(rootDir, FORK_REMOTE, { run });

  if (existing === undefined) {
    await doStep(`Adding the remote '${FORK_REMOTE}' for ${login}/${repo.name}`, async () => {
      const added = await run("git", ["remote", "add", FORK_REMOTE, forkUrl], {
        cwd: rootDir,
      });
      if (added.code !== 0) {
        throw new ConfigError(
          `Could not add the remote '${FORK_REMOTE}'.\n  ${added.stderr.trim()}`
        );
      }
    });
  }

  return `${login}:${branch}`;
}

/** The `gh pr create` arguments for one proposal. */
function githubArgs(
  repo: CanonicalRepo,
  head: string,
  base: string,
  title: string,
  body: string,
  draft: boolean
): string[] {
  const args = [
    "pr",
    "create",
    "--repo",
    `${repo.owner}/${repo.name}`,
    "--base",
    base,
    "--head",
    head,
    "--title",
    title,
    "--body",
    body,
  ];
  if (draft) args.push("--draft");
  return args;
}

/** The `glab mr create` arguments for one proposal. */
function gitlabArgs(
  branch: string,
  base: string,
  title: string,
  body: string,
  draft: boolean
): string[] {
  const args = [
    "mr",
    "create",
    "--source-branch",
    branch,
    "--target-branch",
    base,
    "--title",
    title,
    "--description",
    body,
    "--yes",
  ];
  if (draft) args.push("--draft");
  return args;
}

/** The title used when there is no commit subject to borrow. */
function defaultTitle(validation: RepoValidation): string {
  return `Update the ${validation.manifest.name} recipes`;
}

/** The body sous writes when the contributor did not supply one. */
function defaultBody(built: IndexBuildResult, validation: RepoValidation): string {
  const lines = [
    `Proposed with 'sous repo submit' from the ${validation.manifest.name} repository.`,
    "",
    "Recipes in this repository:",
  ];
  for (const recipe of validation.recipes) {
    lines.push(`- ${recipe.key} at version ${recipe.manifest.version}`);
  }
  if (built.pending.length > 0) {
    lines.push("");
    lines.push("Versions this proposal would publish once it is merged and tagged:");
    for (const entry of built.pending) {
      lines.push(`- ${entry.key} ${entry.version}`);
    }
  }
  return lines.join("\n");
}

/** True when a command ran and exited successfully, whatever it printed. */
async function commandSucceeds(
  run: CommandRunner,
  command: string,
  args: string[],
  cwd?: string
): Promise<boolean> {
  try {
    const result = await run(command, args, { cwd });
    return result.code === 0;
  } catch {
    return false;
  }
}

/** A command's standard output, or undefined when it did not succeed. */
async function capturedOutput(
  run: CommandRunner,
  command: string,
  args: string[],
  cwd?: string
): Promise<string | undefined> {
  try {
    const result = await run(command, args, { cwd });
    if (result.code !== 0) return undefined;
    return result.stdout;
  } catch {
    return undefined;
  }
}

/** The first URL in a command's output, which is where its result lives. */
function firstUrlIn(output: string): string | undefined {
  const match = /https?:\/\/\S+/.exec(output);
  return match === null ? undefined : match[0];
}

/**
 * Turns a mid-flight failure into an error that says what already happened.
 * A pushed branch with no pull request behind it is a state the contributor
 * has to know about; silence would leave them guessing.
 */
function partialStateError(
  failedStep: string,
  completed: ReadonlyArray<string>,
  error: unknown
): ConfigError {
  const done =
    completed.length === 0
      ? "    nothing had been sent yet"
      : completed.map((entry) => `    ${entry}`).join("\n");

  return new ConfigError(
    `${failedStep}: this step failed.\n\n` +
      `  ${error instanceof Error ? error.message : String(error)}\n\n` +
      `  What had already been done:\n${done}\n\n` +
      `  Nothing after that step ran. Fix the problem above and run the command again; ` +
      `sous starts from where the repository actually is, so a step that already ` +
      `succeeded is not repeated.`
  );
}
