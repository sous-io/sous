/**
 * Proposing a change to a recipe repository: validate first, then delegate.
 *
 * `submit` universally means "propose a change for maintainers to review". It
 * never publishes and never writes to a repository directly; the fork and
 * proposal mechanics belong to the provider, which knows its own host and
 * already has the contributor's credentials through that host's command line
 * tool.
 *
 * This module is a SEQUENCER and nothing more. It knows the order the steps go
 * in, what each one is called, and what to say when one fails; it does not know
 * that GitHub exists, which tool proposes a change, or how a fork is spelled.
 * Every host-specific fact is asked of the provider interface and comes back as
 * plain data, which is what keeps a third provider a single new file.
 *
 * Two rules shape everything here:
 *
 * - Nothing is sent until the repository validates and its index is current. A
 *   proposal that fails the maintainer's own checks wastes their review.
 * - Every step announces itself BEFORE it runs, and a failure says exactly which
 *   steps completed. A half-finished submission (a branch pushed, no proposal
 *   opened) is a normal outcome of a network failure, and the contributor has to
 *   be told the truth about it.
 *
 * Every subprocess goes through the injectable runner, so no test here reaches
 * a network.
 */

import { ConfigError } from "../../errors.js";
import { runGit, type CommandRunner } from "../providers/git.js";
import { detectProvider } from "../providers/index.js";
import {
  supportsSubmit,
  type CanonicalRepo,
  type ProviderOptions,
  type RepoProvider,
  type SubmitCapableProvider,
} from "../providers/provider.js";
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

/** What a proposal is called when the provider does not name it. */
const DEFAULT_PROPOSAL_NOUN = "proposal";

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
  /** The proposal's URL, when the provider reported one. */
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
    run,
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
  //
  // The cheap, actionable checks come first. A repository with an uncommitted
  // file is the commonest reason a submission stops, and saying so is far more
  // useful than a content hash disagreeing because of that same uncommitted
  // file. The manifests are read this early only for the contribution
  // pointer; what the recipes say is only judged once the ground is firm.

  step("Reading the repository manifest and every recipe in it");
  const validation = validateRepo(rootDir);
  completed.push("Read the repository manifest and every recipe in it");

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
  const repo = provider.canonicalize(upstreamUrl);

  // Everything the provider runs, it runs inside the contributor's checkout.
  const providerOptions: ProviderOptions = { cwd: rootDir, run };

  const signInLabel = provider.cli?.label ?? "the repository host's command line tool";
  step(`Checking that ${signInLabel} is installed and signed in`);
  const auth = await provider.authStatus(providerOptions);
  if (!auth.ok) {
    throw new ConfigError(`${auth.detail}\n` + contributePointer(validation));
  }
  completed.push(`Checked that ${signInLabel} is installed and signed in`);

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

  // --- Validate what is about to be proposed --------------------------------

  step("Checking that every recipe describes itself correctly");
  assertRepoValidates(validation);
  completed.push("Checked that every recipe describes itself correctly");

  step("Confirming the committed index is current");
  const built = await buildIndex({
    validation,
    existing: readIndexFile(rootDir),
    sousVersion,
    run,
  });
  assertIndexReady(built, readIndexFile(rootDir));
  completed.push("Confirmed the committed index is current");

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
  let forkOwner: string | undefined;

  step("Checking whether you can push to the repository itself");
  const canPush = await provider.canPush(repo, providerOptions);
  completed.push("Checked whether you can push to the repository itself");

  if (canPush === undefined) {
    notice(
      `Sous could not tell whether you can push to ${repo.owner}/${repo.name}, so the change ` +
        `goes to '${UPSTREAM_REMOTE}' as it stands.`
    );
  } else if (!canPush) {
    usedFork = true;
    pushRemote = FORK_REMOTE;
    if (dryRun) {
      notice(
        `You cannot push to ${repo.owner}/${repo.name}, so the change would go through ` +
          `a fork on your own account.`
      );
    } else {
      forkOwner = await prepareFork(
        rootDir,
        repo,
        provider,
        providerOptions,
        run,
        doStep
      );
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

  const proposalNoun = provider.proposalNoun ?? DEFAULT_PROPOSAL_NOUN;
  const proposed = await doStep(`Opening a ${proposalNoun} for review`, () =>
    provider.proposeChange(
      repo,
      {
        branch: branch!,
        base: baseBranch,
        title,
        body,
        draft,
        ...(forkOwner === undefined ? {} : { head: { owner: forkOwner } }),
      },
      providerOptions
    )
  );
  if (proposed.url === undefined) notice(proposed.detail);

  return {
    provider: provider.id,
    repo,
    branch: branch!,
    baseBranch,
    usedFork,
    pushedTo: pushRemote,
    title,
    ...(proposed.url === undefined ? {} : { url: proposed.url }),
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
 * contributor at whatever route the repository documents instead. The feature
 * list is the only thing consulted: a provider that does not promise `submit`
 * is not asked to, whatever host it serves.
 */
function requireSubmitProvider(
  upstreamUrl: string,
  validation: RepoValidation,
  providers?: RepoProvider[]
): SubmitCapableProvider {
  const provider =
    providers === undefined ? detectProvider(upstreamUrl) : detectProvider(upstreamUrl, providers);

  if (provider === undefined) {
    throw new ConfigError(
      `Sous does not know how to propose a change to ${upstreamUrl}.\n` +
        contributePointer(validation)
    );
  }
  if (!supportsSubmit(provider)) {
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
 * Asks the provider to fork the repository onto the contributor's own account,
 * then makes sure a git remote points at whatever came back. The fork itself is
 * the provider's business; the remote is git's, and therefore sous's.
 *
 * Returns the account the fork lives under, which is what a cross-repository
 * proposal needs.
 */
async function prepareFork(
  rootDir: string,
  repo: CanonicalRepo,
  provider: SubmitCapableProvider,
  providerOptions: ProviderOptions,
  run: CommandRunner | undefined,
  doStep: <T>(message: string, action: () => Promise<T>) => Promise<T>
): Promise<string> {
  const fork = await doStep(`Forking ${repo.owner}/${repo.name} onto your own account`, () =>
    provider.fork(repo, providerOptions)
  );

  const existing = await remoteUrl(rootDir, FORK_REMOTE, { run });
  if (existing === undefined) {
    await doStep(`Adding the remote '${FORK_REMOTE}' for ${fork.owner}/${fork.name}`, async () => {
      try {
        await runGit(["remote", "add", FORK_REMOTE, fork.httpsUrl], { cwd: rootDir, run });
      } catch (error) {
        throw new ConfigError(
          `Could not add the remote '${FORK_REMOTE}'.\n  ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  return fork.owner;
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

/**
 * Turns a mid-flight failure into an error that says what already happened.
 * A pushed branch with no proposal behind it is a state the contributor has to
 * know about; silence would leave them guessing.
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
