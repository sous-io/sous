/**
 * Proposing a change to a recipe repository, over the proposal's whole life.
 *
 * `submit` universally means "propose a change for maintainers to review". It
 * never publishes and never writes to a repository directly; the fork and
 * proposal mechanics belong to the provider, which knows its own host and
 * already has the contributor's credentials through that host's command line
 * tool.
 *
 * One command covers a proposal from start to finish, for the branch that is
 * checked out or the one `--branch` names:
 *
 *   - no proposal yet: open one;
 *   - an open proposal: push whatever is new, which updates it, and replace its
 *     title or body when new ones are given; with nothing new, report on it;
 *   - a merged proposal: say so, and continue on a new branch (named, generated,
 *     or not at all), which gets a new proposal;
 *   - a proposal closed without merging: say so, and open a fresh one;
 *   - a pushed branch holding commits the local one lacks: git refuses the push,
 *     and its refusal is passed through. Nothing here ever forces a push.
 *
 * This module is a SEQUENCER and nothing more. It knows the order the steps go
 * in, what each one is called, and what to say when one fails; it does not know
 * that GitHub exists, which tool proposes a change, or how a fork is spelled.
 * Every host-specific fact is asked of the provider interface and comes back as
 * plain data, which is what keeps a third provider a single new file. Every
 * question is asked through `SubmitQuestions`, so the command decides how a
 * question is put (or which flag answered it) and this module never prompts.
 *
 * Three rules shape everything here:
 *
 * - Everything is worked out, and every question asked, before anything is
 *   written. A contributor who declines, or a run that cannot ask, leaves the
 *   checkout exactly as it found it.
 * - Nothing is sent until the repository validates and the contributor has left
 *   its index alone. Whether the index agrees with the tags is the maintainer's
 *   check (`sous repo release --check`, on a full clone), not the contributor's.
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
  supportsProposals,
  supportsSubmit,
  type CanonicalRepo,
  type ProposalStatus,
  type ProposalSummary,
  type ProviderOptions,
  type RepoProvider,
  type SubmitCapableProvider,
} from "../providers/provider.js";
import { INDEX_FILENAME } from "../formats/common.js";
import {
  buildChangelog,
  composeProposalBody,
  readManifestsAt,
  renderChangelog,
  snapshotOf,
  type Changelog,
} from "./changelog.js";
import {
  branchExists,
  commitEverything,
  createBranch,
  currentBranch,
  defaultBranch,
  forkPoint,
  hasCommitIdentity,
  pathChangedSince,
  pathsChangedSince,
  pushBranch,
  remoteUrl,
  submitBranchName,
  switchBranch,
  uncommittedChanges,
  type ChangedPath,
} from "./git-state.js";
import { recipesRefusingSubmissions, type RefusingRecipe } from "./submissions.js";
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

/** How the contributor wants to go on after a proposal was merged. */
export type NextBranchChoice =
  | { kind: "name"; name: string }
  | { kind: "generate" }
  | { kind: "cancel" };

/**
 * Every question a submission may need answered. The command supplies these:
 * it knows whether a terminal is attached and which flags were passed, and a
 * question that cannot be asked raises the error naming the flag that answers
 * it. The sequencer only ever asks, and only before anything is written.
 */
export type SubmitQuestions = {
  /** The proposal's title, when it is required and was not given. */
  title(): Promise<string>;
  /** The proposal's description, when it is required and was not given. */
  body(): Promise<string>;
  /** Whether to commit the listed paths, for `--commit`. */
  confirmCommit(paths: ReadonlyArray<ChangedPath>): Promise<boolean>;
  /** Whether to propose a change to recipes that say they take no proposals. */
  proceedDespiteSubmissions(refusing: ReadonlyArray<RefusingRecipe>): Promise<boolean>;
  /** Where to go on after the branch's proposal was merged. */
  nextBranch(merged: ProposalSummary, generated: string): Promise<NextBranchChoice>;
};

/** What `submitRepo` needs to know. */
export type SubmitOptions = {
  /** The repository's root directory. */
  rootDir: string;
  /** The title for the proposal. Required for a new one; replaces an open one's when given. */
  title?: string;
  /** The description for the proposal. Required for a new one; replaces an open one's when given. */
  body?: string;
  /** Whether to open a new proposal as a draft. */
  draft?: boolean;
  /** The branch to work with, instead of the one that is checked out. */
  branch?: string;
  /** When true, only report on the branch's proposal; nothing is checked, written or sent. */
  statusOnly?: boolean;
  /** When true, uncommitted changes are committed (after a confirmation) rather than refused. */
  commit?: boolean;
  /** When true, everything is checked and reported and nothing is written or sent. */
  dryRun?: boolean;
  /** How questions are asked. Defaults to refusing every one of them. */
  questions?: SubmitQuestions;
  /** When the submission is happening; decides a generated branch name. Defaults to now. */
  now?: Date;
  /** How subprocesses are run. Defaults to spawning a real process. */
  run?: CommandRunner;
  /** The providers to consider. Defaults to the built-in list. */
  providers?: RepoProvider[];
  /** Called with each step, BEFORE it runs. */
  onStep?: (message: string) => void;
  /** Called with anything worth saying that is not a step. */
  onNotice?: (message: string) => void;
  /** Called with a warning the contributor should weigh. Defaults to `onNotice`. */
  onWarning?: (message: string) => void;
};

/**
 * How a submission ended.
 *
 * - `created`: a new proposal was opened (or, on a dry run, would be).
 * - `updated`: an open proposal received new commits, a new title or a new body.
 * - `unchanged`: an open proposal had nothing new to receive; its status is reported.
 * - `status`: `--status` reported on the branch's proposal, or on its absence.
 * - `cancelled`: the contributor declined a question, and nothing was written.
 */
export type SubmitOutcome = "created" | "updated" | "unchanged" | "status" | "cancelled";

/** What a submission did. */
export type SubmitResult = {
  /** How it ended. */
  outcome: SubmitOutcome;
  /** The provider the proposal went to. */
  provider: string;
  /** What the provider calls a proposal. */
  proposalNoun: string;
  /** The repository, as the provider understands it. */
  repo: CanonicalRepo;
  /** The branch the change is on. */
  branch: string;
  /** The branch the proposal targets. */
  baseBranch: string;
  /** True when the change goes through a fork rather than to the repository itself. */
  usedFork: boolean;
  /** The remote the branch was (or would be) pushed to. */
  pushedTo: string;
  /** The proposal's title, when this run set one. */
  title?: string;
  /** The proposal's URL, when the provider reported one. */
  url?: string;
  /** The branch's proposal as it stood before this run, when it had one. */
  previous?: ProposalSummary;
  /** Where the proposal stands, when this run reported on it. */
  status?: ProposalStatus;
  /** The paths committed for the contributor, with `--commit`. */
  committed?: string[];
  /** The changelog, when this run generated one. */
  changelog?: Changelog;
  /** Recipes the change touches that do not take proposals. */
  refusing: RefusingRecipe[];
  /** Every step that completed, in order. */
  completed: string[];
  /** True when nothing was actually written or sent. */
  dryRun: boolean;
};

/** The questions a caller that supplied none gets: each one refuses. */
const REFUSING_QUESTIONS: SubmitQuestions = {
  title: async () => {
    throw new ConfigError("A new proposal needs a title; pass '--title'.");
  },
  body: async () => {
    throw new ConfigError("A new proposal needs a description; pass '--body'.");
  },
  confirmCommit: async () => false,
  proceedDespiteSubmissions: async () => false,
  nextBranch: async () => ({ kind: "cancel" }),
};

/**
 * Validates a repository and carries its branch's proposal one step further:
 * opens it, updates it, reports on it, or starts the next one.
 *
 * @param options - The repository, the proposal's text, the flags and the testing seams.
 */
export async function submitRepo(options: SubmitOptions): Promise<SubmitResult> {
  const { rootDir, draft = false, dryRun = false, now = new Date(), run } = options;
  const questions = options.questions ?? REFUSING_QUESTIONS;
  const step = options.onStep ?? (() => {});
  const notice = options.onNotice ?? (() => {});
  const warn = options.onWarning ?? notice;
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

  /** Runs one read-only check, announcing it first. */
  const check = async <T>(message: string, done: string, action: () => Promise<T>) => {
    step(message);
    const result = await action();
    completed.push(done);
    return result;
  };

  // --- Preflight: is this a repository sous can propose a change to? --------
  //
  // The cheap, actionable checks come first. The manifests are read this early
  // only for the contribution pointer; what the recipes say is only judged once
  // the ground is firm.

  const validation = await check(
    "Reading the repository manifest and every recipe in it",
    "Read the repository manifest and every recipe in it",
    async () => validateRepo(rootDir)
  );

  const upstreamUrl = await check(
    "Looking up where this repository was cloned from",
    "Looked up where this repository was cloned from",
    () => remoteUrl(rootDir, UPSTREAM_REMOTE, { run })
  );
  if (upstreamUrl === undefined) {
    throw new ConfigError(
      `This repository has no '${UPSTREAM_REMOTE}' remote, so sous cannot tell where to ` +
        `propose the change.\n` +
        `  Add one with 'git remote add ${UPSTREAM_REMOTE} <url>', then run the command again.`
    );
  }

  const provider = requireSubmitProvider(upstreamUrl, validation, options.providers);
  const repo = provider.canonicalize(upstreamUrl);
  const proposalNoun = provider.proposalNoun ?? DEFAULT_PROPOSAL_NOUN;
  const tracksProposals = supportsProposals(provider);

  // Everything the provider runs, it runs inside the contributor's checkout.
  const providerOptions: ProviderOptions = { cwd: rootDir, run };

  const signInLabel = provider.cli?.label ?? "the repository host's command line tool";
  const auth = await check(
    `Checking that ${signInLabel} is installed and signed in`,
    `Checked that ${signInLabel} is installed and signed in`,
    () => provider.authStatus(providerOptions)
  );
  if (!auth.ok) {
    throw new ConfigError(`${auth.detail}\n` + contributePointer(validation));
  }

  const baseBranch = (await defaultBranch(rootDir, { run })) ?? "main";
  const checkedOut = await currentBranch(rootDir, { run });

  // --- Where the change goes: the repository itself, or a fork -------------

  const canPush = await check(
    "Checking whether you can push to the repository itself",
    "Checked whether you can push to the repository itself",
    () => provider.canPush(repo, providerOptions)
  );
  const usedFork = canPush === false;
  const pushRemote = usedFork ? FORK_REMOTE : UPSTREAM_REMOTE;
  if (canPush === undefined) {
    notice(
      `Sous could not tell whether you can push to ${repo.owner}/${repo.name}, so the change ` +
        `goes to '${UPSTREAM_REMOTE}' as it stands.`
    );
  }
  const knownForkOwner = usedFork ? await forkOwnerFromRemote(rootDir, provider, run) : undefined;

  const base = {
    provider: provider.id,
    proposalNoun,
    repo,
    baseBranch,
    usedFork,
    pushedTo: pushRemote,
    completed,
    dryRun,
  };

  /** Looks up the proposal a branch was pushed for, when the provider can. */
  const lookUp = async (branch: string): Promise<ProposalSummary | undefined> => {
    if (!supportsProposals(provider)) return undefined;
    return check(
      `Looking for a ${proposalNoun} for the branch '${branch}'`,
      `Looked for a ${proposalNoun} for the branch '${branch}'`,
      () =>
        provider.findProposal(
          repo,
          {
            branch,
            fromFork: usedFork,
            ...(knownForkOwner === undefined ? {} : { forkOwner: knownForkOwner }),
          },
          providerOptions
        )
    );
  };

  /** Asks the provider where a proposal stands. */
  const statusOf = async (proposal: ProposalSummary): Promise<ProposalStatus> => {
    if (!supportsProposals(provider)) return { proposal };
    return check(
      `Reading where the ${proposalNoun} stands`,
      `Read where the ${proposalNoun} stands`,
      () => provider.proposalStatus(repo, proposal.id, providerOptions)
    );
  };

  // --- Status only ------------------------------------------------------------

  if (options.statusOnly === true) {
    if (!tracksProposals) {
      throw new ConfigError(
        `The '${provider.id}' provider cannot look a ${proposalNoun} up after it was opened, ` +
          `so sous cannot report on one.\n` +
          `  Open the repository on its host to see where the ${proposalNoun} stands.`
      );
    }
    const branch = options.branch ?? checkedOut;
    if (branch === undefined) {
      throw new ConfigError(
        "No branch is checked out, so there is no proposal to report on.\n" +
          "  Name the branch with '--branch <name>'."
      );
    }
    const found = await lookUp(branch);
    const status = found === undefined ? undefined : await statusOf(found);
    return {
      ...base,
      outcome: "status",
      branch,
      ...(found?.url === undefined ? {} : { url: found.url }),
      ...(found === undefined ? {} : { previous: found }),
      ...(status === undefined ? {} : { status }),
      refusing: [],
      dryRun: true,
    };
  }

  // --- The working tree -------------------------------------------------------

  const uncommitted = await check(
    "Checking that everything is committed",
    "Checked that everything is committed",
    () => uncommittedChanges(rootDir, { run })
  );
  const toCommit = options.commit === true ? uncommitted : [];

  if (uncommitted.length > 0 && options.commit !== true) {
    const listed = uncommitted.map((entry) => `    ${entry.path}`).join("\n");
    throw new ConfigError(
      "Cannot propose a change while the working tree has uncommitted changes.\n\n" +
        `${listed}\n\n` +
        "  A proposal is made of commits, so everything it should carry has to be " +
        "committed first.\n" +
        "  Commit these yourself, or pass '--commit' to have sous commit them, then run " +
        "the command again."
    );
  }
  if (options.commit === true && uncommitted.length === 0) {
    notice("Everything is already committed, so '--commit' has nothing to commit.");
  }
  if (toCommit.some((entry) => entry.path === INDEX_FILENAME)) {
    throw indexEditedError(`git checkout HEAD -- ${INDEX_FILENAME}`);
  }
  if (toCommit.length > 0) {
    // Checked before anything is written, so a missing identity is reported
    // rather than surfacing as git's own error halfway through.
    const identified = await check(
      "Checking that git knows who is committing",
      "Checked that git knows who is committing",
      () => hasCommitIdentity(rootDir, { run })
    );
    if (!identified) {
      throw new ConfigError(
        "Sous cannot commit for you, because git cannot work out who is committing.\n" +
          "  Set it with 'git config user.name \"Your Name\"' and " +
          "'git config user.email you@example.com', then run the command again."
      );
    }
  }

  // --- Validate what is about to be proposed --------------------------------

  step("Checking that every recipe describes itself correctly");
  assertRepoValidates(validation);
  completed.push("Checked that every recipe describes itself correctly");

  const since = await check(
    `Checking that ${INDEX_FILENAME} was left alone`,
    `Checked that ${INDEX_FILENAME} was left alone`,
    async () => {
      const point = await forkPoint(rootDir, UPSTREAM_REMOTE, baseBranch, { run });
      if (point === undefined) {
        notice(
          `This checkout holds no copy of '${UPSTREAM_REMOTE}/${baseBranch}', so sous could not ` +
            `check whether ${INDEX_FILENAME} was changed, which recipes the change touches, or ` +
            `what merging it changes.`
        );
      } else if (await pathChangedSince(rootDir, point, INDEX_FILENAME, { run })) {
        throw indexEditedError(`git checkout ${point.slice(0, 12)} -- ${INDEX_FILENAME}`);
      }
      return point;
    }
  );

  // Every path the change touches: its commits, and whatever --commit adds.
  const changedPaths = [
    ...(since === undefined ? [] : await pathsChangedSince(rootDir, since, { run })),
    ...toCommit.map((entry) => entry.path),
  ];

  // --- Recipes that take no proposals ---------------------------------------

  const refusing = recipesRefusingSubmissions(validation, changedPaths);
  if (refusing.length > 0) {
    warn(describeRefusing(refusing));
    if (!(await questions.proceedDespiteSubmissions(refusing))) {
      return cancelled("You chose not to propose a change to those recipes.");
    }
  }

  // --- Which branch, and which proposal -------------------------------------

  /** Ends the run with nothing written, saying why. */
  function cancelled(reason: string): SubmitResult {
    notice(`${reason} Nothing was written.`);
    return {
      ...base,
      outcome: "cancelled",
      branch: options.branch ?? checkedOut ?? baseBranch,
      refusing,
      dryRun: true,
    };
  }

  // The plan for the branch: stay, switch to an existing one, or create one.
  let branch: string;
  let branchAction: "stay" | "switch" | "create";
  if (options.branch !== undefined && options.branch !== checkedOut) {
    branch = options.branch;
    branchAction = (await branchExists(rootDir, branch, { run })) ? "switch" : "create";
  } else if (checkedOut === undefined || checkedOut === baseBranch) {
    branch = options.branch ?? submitBranchName(now);
    branchAction = "create";
  } else {
    branch = checkedOut;
    branchAction = "stay";
  }

  let previous: ProposalSummary | undefined;
  if (branchAction !== "create") {
    previous = await lookUp(branch);
  } else if (tracksProposals && options.branch !== undefined) {
    // A named branch that does not exist here may still have been pushed from
    // another machine, with a proposal behind it.
    previous = await lookUp(branch);
  }
  if (!tracksProposals) {
    notice(
      `The '${provider.id}' provider cannot look for a ${proposalNoun} that is already open, ` +
        `so sous opens a new one. If this branch already has one, pushing updates it and ` +
        `opening another may be refused.`
    );
  }

  let action: "create" | "update" = previous?.state === "open" ? "update" : "create";

  if (previous?.state === "merged") {
    notice(
      `The ${proposalNoun} for '${branch}' was merged` +
        (previous.url === undefined ? "." : `: ${previous.url}.`) +
        " A merged branch takes no further changes, so the next change goes on a new branch."
    );
    const generated = submitBranchName(now);
    const choice = await questions.nextBranch(previous, generated);
    if (choice.kind === "cancel") {
      return cancelled("You chose not to continue on a new branch.");
    }
    branch = choice.kind === "name" ? choice.name.trim() : generated;
    branchAction = "create";
    action = "create";
  } else if (previous?.state === "closed") {
    notice(
      `The ${proposalNoun} for '${branch}' was closed without being merged` +
        (previous.url === undefined ? "." : `: ${previous.url}.`) +
        ` A fresh ${proposalNoun} is opened for the branch.`
    );
  }

  // --- The text ---------------------------------------------------------------
  //
  // A new proposal needs a title and a description written by the person
  // proposing it, and so does a commit sous makes for them; sous never derives
  // either from commit messages. An update takes them only when given.

  const needsText = action === "create" || toCommit.length > 0;
  let title = blankToUndefined(options.title);
  let description = blankToUndefined(options.body);
  if (needsText && title === undefined) title = (await questions.title()).trim();
  if (needsText && description === undefined) description = (await questions.body()).trim();
  if (needsText && (title === undefined || title.length === 0)) {
    throw new ConfigError(`A new ${proposalNoun} needs a title; pass '--title'.`);
  }
  if (needsText && (description === undefined || description.length === 0)) {
    throw new ConfigError(`A new ${proposalNoun} needs a description; pass '--body'.`);
  }

  if (toCommit.length > 0 && !(await questions.confirmCommit(toCommit))) {
    return cancelled("You chose not to commit those changes.");
  }

  // --- The changelog ----------------------------------------------------------

  const changelog = buildChangelog({
    baseBranch,
    base: since === undefined ? undefined : await readManifestsAt(rootDir, since, { run }),
    head: snapshotOf(validation),
    changedPaths,
  });
  const proposalBody =
    description === undefined ? undefined : composeProposalBody(description, changelog);

  // --- A dry run stops here ---------------------------------------------------

  if (dryRun) {
    if (branchAction === "create") {
      notice(`A branch named '${branch}' would be created from the current commit.`);
    } else if (branchAction === "switch") {
      notice(`The branch '${branch}' would be checked out.`);
    }
    if (toCommit.length > 0) {
      notice(`${describeCount(toCommit.length, "path")} would be committed.`);
    }
    if (usedFork) {
      notice(
        `You cannot push to ${repo.owner}/${repo.name}, so the change would go through a ` +
          `fork on your own account.`
      );
    }
    notice("Nothing was sent; this was a dry run.");
    return {
      ...base,
      outcome: action === "update" ? "updated" : "created",
      branch,
      ...(title === undefined ? {} : { title }),
      ...(previous === undefined ? {} : { previous }),
      ...(previous?.url === undefined || action !== "update" ? {} : { url: previous.url }),
      changelog,
      refusing,
      dryRun: true,
    };
  }

  // --- Write: the branch, the commit ------------------------------------------

  if (branchAction === "create") {
    await doStep(`Creating the branch '${branch}' from the current commit`, () =>
      createBranch(rootDir, branch, { run })
    );
  } else if (branchAction === "switch") {
    await doStep(`Checking out the branch '${branch}'`, () =>
      switchBranch(rootDir, branch, { run })
    );
  }

  if (toCommit.length > 0) {
    await doStep(`Committing ${describeCount(toCommit.length, "path")}`, () =>
      commitEverything(rootDir, commitMessage(title!, description!, changelog), { run })
    );
  }

  // --- Fork, push, propose ----------------------------------------------------

  let forkOwner = knownForkOwner;
  if (usedFork) {
    forkOwner = await prepareFork(rootDir, repo, provider, providerOptions, run, doStep);
  }

  const pushed = await doStep(`Pushing '${branch}' to '${pushRemote}'`, () =>
    pushBranch(rootDir, pushRemote, branch, { run }).catch((error: unknown) => {
      throw new ConfigError(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `  Sous never forces a push. When the branch on '${pushRemote}' holds commits yours ` +
          `lacks (a maintainer may have pushed to it), bring them in with ` +
          `'git pull ${pushRemote} ${branch}', then run the command again.`
      );
    })
  );

  if (action === "update" && previous !== undefined && supportsProposals(provider)) {
    const replace = {
      ...(title === undefined ? {} : { title }),
      ...(proposalBody === undefined ? {} : { body: proposalBody }),
    };
    let url = previous.url;
    if (Object.keys(replace).length > 0) {
      const updated = await doStep(`Updating the ${proposalNoun}'s title and body`, () =>
        provider.updateProposal(repo, previous!.id, replace, providerOptions)
      );
      url = updated.url ?? url;
    }
    const changed = pushed === "updated" || Object.keys(replace).length > 0;
    const status = await statusOf(previous);
    return {
      ...base,
      outcome: changed ? "updated" : "unchanged",
      branch,
      ...(title === undefined ? {} : { title }),
      ...(url === undefined ? {} : { url }),
      previous,
      status,
      ...(toCommit.length > 0 ? { committed: toCommit.map((entry) => entry.path) } : {}),
      changelog,
      refusing,
      dryRun: false,
    };
  }

  const proposed = await doStep(`Opening a ${proposalNoun} for review`, () =>
    provider.proposeChange(
      repo,
      {
        branch,
        base: baseBranch,
        title: title!,
        body: proposalBody!,
        draft,
        ...(forkOwner === undefined ? {} : { head: { owner: forkOwner } }),
      },
      providerOptions
    )
  );
  if (proposed.url === undefined) notice(proposed.detail);

  return {
    ...base,
    outcome: "created",
    branch,
    title: title!,
    ...(proposed.url === undefined ? {} : { url: proposed.url }),
    ...(previous === undefined ? {} : { previous }),
    ...(toCommit.length > 0 ? { committed: toCommit.map((entry) => entry.path) } : {}),
    changelog,
    refusing,
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

/** The refusal for a change that edits the index, naming how to put it back. */
function indexEditedError(restore: string): ConfigError {
  return new ConfigError(
    `This change edits ${INDEX_FILENAME}. The index is written by the repository's own ` +
      `release, after a change is merged, so a proposal leaves it as it found it.\n` +
      `  Restore it with '${restore}', commit that, then run the command again.`
  );
}

/** Renders a list of problems as an indented block. */
function renderProblems(problems: ReadonlyArray<ValidationProblem>): string {
  return problems.map((problem) => `    ${problem.where}: ${problem.message}`).join("\n");
}

/**
 * Says which recipes a change touches although they take no proposals, and
 * where each asks for changes to go instead.
 *
 * @param refusing - The recipes, as `recipesRefusingSubmissions` found them.
 */
export function describeRefusing(refusing: ReadonlyArray<RefusingRecipe>): string {
  const lines = [
    refusing.length === 1
      ? "This change touches a recipe that does not take proposed changes:"
      : "This change touches recipes that do not take proposed changes:",
  ];
  for (const recipe of refusing) {
    const where =
      recipe.declaredBy === "recipe" ? "its own manifest" : "the repository manifest";
    lines.push(`  ${recipe.key} (${recipe.path}), as ${where} says.`);
    if (recipe.instead !== undefined) lines.push(`    Instead: ${recipe.instead}`);
  }
  lines.push(
    "Merging such a change usually breaks whatever publishes those recipes, and the " +
      "repository's own check refuses it."
  );
  return lines.join("\n");
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

/** A string with its surrounding whitespace removed, or undefined when nothing is left. */
function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** "1 path", "3 paths". */
function describeCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The message `--commit` commits with: the title as the subject, then the
 * description, then the changelog.
 *
 * @param title - The proposal's title.
 * @param description - The contributor's description.
 * @param changelog - The generated changelog.
 */
export function commitMessage(title: string, description: string, changelog: Changelog): string {
  return `${title}\n\n${description}\n\n${renderChangelog(changelog)}\n`;
}

// --- Delegation helpers -------------------------------------------------------------------------

/**
 * The owner of the fork a `fork` remote already points at, which is the head
 * owner a proposal from it carries. Undefined when there is no such remote, or
 * when its URL is not one the provider can read.
 */
async function forkOwnerFromRemote(
  rootDir: string,
  provider: RepoProvider,
  run: CommandRunner | undefined
): Promise<string | undefined> {
  const url = await remoteUrl(rootDir, FORK_REMOTE, { run });
  if (url === undefined || !provider.matches(url)) return undefined;
  try {
    return provider.canonicalize(url).owner;
  } catch {
    return undefined;
  }
}

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
