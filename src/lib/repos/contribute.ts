/**
 * What `sous repo contribute` chains together, and how it decides whether a
 * branch still has something to propose.
 *
 * Contributing to a recipe repository is a lifecycle: start (link the
 * repository on a fresh branch of an up-to-date checkout), edit, propose,
 * revise, and finish (propose whatever is left, then go back to the published
 * versions). Each part already has a command of its own (`sous repo link`,
 * `sous repo submit`, `sous repo unlink`), and the contribution command adds
 * nothing those commands lack: this module only works out which of them to run,
 * with which flags, in which order.
 *
 * A step is described as the command it runs and the arguments it passes, so
 * the command can run it in-process, print it for a dry run, and name it in a
 * failure, all from one description. Everything here that reads the checkout
 * goes through the injectable git runner, so no test needs a network.
 */

import { ConfigError } from "../errors.js";
import {
  currentBranch,
  defaultBranch,
  runGit,
  UPSTREAM_REMOTE,
  type GitOptions,
} from "./git-clone.js";
import type { ProposalSummary } from "./providers/provider.js";
import { FORK_REMOTE } from "./release/submit-service.js";

/** The commands a contribution is made of, by their oclif ids. */
export type ContributionCommand = "repo:link" | "repo:submit" | "repo:unlink";

/** One command a contribution runs, and how to talk about it. */
export type ContributionStep = {
  /** The command's oclif id. */
  command: ContributionCommand;
  /** The arguments and flags passed to it, exactly as a command line would carry them. */
  argv: string[];
  /** What the step does, as a heading printed when it starts. */
  running: string;
  /** What the step did, as a line in the list of completed steps. */
  done: string;
};

/**
 * Config-locating flags the contribution command was given, which every step
 * that discovers a project config has to be given as well, or it could find a
 * different project from the one the contribution started in.
 */
export type LocatorFlags = {
  config?: string;
  "sous-dir"?: string;
  "sous-confd"?: string;
};

/** The flags that shape the start of a contribution. */
export type StartFlags = {
  /** `--branch`: an existing branch to work on. */
  branch?: string;
  /** `--create-branch`: a new branch to create. */
  createBranch?: string;
  /** `--generate-branch`: a new branch with a generated name. */
  generateBranch?: boolean;
  /** `--from`: the branch a new branch starts from. */
  from?: string;
  /** `--global`: the machine-wide link. */
  global?: boolean;
  /** The confirmation flag. */
  yes?: boolean;
};

/** The flags that shape the end of a contribution. */
export type FinishFlags = {
  /** `--title`: the proposal's title. */
  title?: string;
  /** `--body`: the proposal's description. */
  body?: string;
  /** `--draft`: open a new proposal as a draft. */
  draft?: boolean;
  /** `--commit`: commit uncommitted changes as part of the submission. */
  commit?: boolean;
  /** `--branch`: the branch to submit, instead of the one checked out. */
  branch?: string;
  /** `--remove`: delete the checkout when unlinking. */
  remove?: boolean;
  /** `--global`: the machine-wide link. */
  global?: boolean;
  /** The confirmation flag. */
  yes?: boolean;
};

/**
 * The config-locating flags, as arguments.
 *
 * @param locator - The flags the contribution command was given.
 */
export function locatorArgs(locator: LocatorFlags): string[] {
  const args: string[] = [];
  if (locator.config !== undefined) args.push("--config", locator.config);
  if (locator["sous-dir"] !== undefined) args.push("--sous-dir", locator["sous-dir"]);
  if (locator["sous-confd"] !== undefined) args.push("--sous-confd", locator["sous-confd"]);
  return args;
}

/**
 * The step that starts a contribution: `sous repo link <repo> --latest` on a
 * new branch. The branch is generated unless one was named, either as a branch
 * to create or as an existing branch to work on.
 *
 * startStep("sous-recipes", {}, {}).argv
 * // -> ["sous-recipes", "--latest", "--generate-branch"]
 *
 * @param repo - The repository's short name.
 * @param flags - The start flags, passed through.
 * @param locator - The config-locating flags, passed through.
 */
export function startStep(
  repo: string,
  flags: StartFlags,
  locator: LocatorFlags = {}
): ContributionStep {
  const argv = [repo, "--latest"];
  let running: string;
  let done: string;

  if (flags.branch !== undefined) {
    argv.push("--branch", flags.branch);
    running = `Linking '${repo}' on the branch '${flags.branch}', made to match upstream's`;
    done = `Linked '${repo}' on the branch '${flags.branch}'`;
  } else if (flags.createBranch !== undefined) {
    argv.push("--create-branch", flags.createBranch);
    running = `Linking '${repo}' on a new branch named '${flags.createBranch}'`;
    done = `Linked '${repo}' on the new branch '${flags.createBranch}'`;
  } else {
    argv.push("--generate-branch");
    running = `Linking '${repo}' on a new branch with a generated name`;
    done = `Linked '${repo}' on a new branch`;
  }

  if (flags.from !== undefined) argv.push("--from", flags.from);
  if (flags.global === true) argv.push("--global");
  if (flags.yes === true) argv.push("--yes");
  argv.push(...locatorArgs(locator));

  return { command: "repo:link", argv, running, done };
}

/**
 * The step that proposes what the branch holds: `sous repo submit <repo>`,
 * with the proposal flags passed through. The confirmation flag is passed only
 * when it was given, so a question the contributor has not answered ahead of
 * time is still asked.
 *
 * submitStep("sous-recipes", { title: "Fix a typo" }).argv
 * // -> ["sous-recipes", "--title", "Fix a typo"]
 *
 * @param repo - The repository's short name.
 * @param flags - The finish flags, passed through.
 */
export function submitStep(repo: string, flags: FinishFlags): ContributionStep {
  const argv = [repo];
  if (flags.title !== undefined) argv.push("--title", flags.title);
  if (flags.body !== undefined) argv.push("--body", flags.body);
  if (flags.branch !== undefined) argv.push("--branch", flags.branch);
  if (flags.draft === true) argv.push("--draft");
  if (flags.commit === true) argv.push("--commit");
  if (flags.yes === true) argv.push("--yes");

  return {
    command: "repo:submit",
    argv,
    running: "Proposing what the branch holds",
    done: "Proposed what the branch holds",
  };
}

/**
 * The step that ends a contribution: `sous repo unlink <repo> --update`, which
 * goes back to the published versions and moves the pins to the newest ones
 * their ranges allow, so a release carrying the change is picked up.
 *
 * unlinkStep("sous-recipes", { remove: true }).argv
 * // -> ["sous-recipes", "--update", "--remove"]
 *
 * @param repo - The repository's short name.
 * @param flags - The finish flags, passed through.
 * @param locator - The config-locating flags, passed through.
 */
export function unlinkStep(
  repo: string,
  flags: FinishFlags,
  locator: LocatorFlags = {}
): ContributionStep {
  const argv = [repo, "--update"];
  if (flags.remove === true) argv.push("--remove");
  if (flags.global === true) argv.push("--global");
  if (flags.yes === true) argv.push("--yes");
  argv.push(...locatorArgs(locator));

  return {
    command: "repo:unlink",
    argv,
    running:
      flags.remove === true
        ? `Unlinking '${repo}', updating its pins and deleting the checkout`
        : `Unlinking '${repo}' and updating its pins`,
    done:
      flags.remove === true
        ? `Unlinked '${repo}', updated its pins and deleted the checkout`
        : `Unlinked '${repo}' and updated its pins`,
  };
}

/**
 * A step written out as the command line that would run it, for a dry run and
 * for anyone who wants to run the parts by hand.
 *
 * commandLine(startStep("sous-recipes", {}))
 * // -> "sous repo link sous-recipes --latest --generate-branch"
 *
 * @param step - The step.
 */
export function commandLine(step: ContributionStep): string {
  const words = ["sous", ...step.command.split(":"), ...step.argv];
  return words.map(quoteArgument).join(" ");
}

/** An argument as a shell would need it written: quoted when it holds anything unusual. */
function quoteArgument(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// --- What the branch still has to propose ----------------------------------------------------------

/** What a checkout's branch holds that a proposal may not carry yet. */
export type PendingWork = {
  /** The branch that was examined, or undefined when HEAD is detached. */
  branch?: string;
  /** The upstream default branch, when it could be worked out. */
  baseBranch?: string;
  /** Every uncommitted change, as `git status --porcelain` prints it. */
  uncommitted: string[];
  /** Commits on the branch that the upstream default branch lacks, one line each. */
  ahead: string[];
  /** Of those, the commits no pushed copy of the branch holds, one line each. */
  unpushed: string[];
  /** The pushed copies of the branch this checkout knows about, such as `origin/my-change`. */
  pushedCopies: string[];
};

/**
 * Reads what a checkout's branch holds that has not been proposed: its
 * uncommitted changes, its commits beyond the upstream default branch, and
 * which of those no pushed copy of the branch holds. Nothing is fetched; the
 * pushed copies are the remote-tracking branches a push leaves behind.
 *
 * pendingWork("/path/to/checkout")
 * // -> { branch: "sous/edit-20260927-1200", baseBranch: "main", uncommitted: [],
 * //      ahead: ["1a2b3c4 Fix a typo"], unpushed: ["1a2b3c4 Fix a typo"], pushedCopies: [] }
 *
 * @param directory - The checkout.
 * @param branch - The branch to examine; the checked-out one when omitted.
 * @param options - The git runner to use.
 */
export function pendingWork(
  directory: string,
  branch?: string,
  options: GitOptions = {}
): PendingWork {
  const runner = options.runner ?? runGit;
  const git = (args: string[]) => runner(args, { cwd: directory });
  const lines = (text: string): string[] =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  const refExists = (ref: string) => git(["rev-parse", "--verify", "--quiet", ref]).status === 0;

  const status = git(["status", "--porcelain"]);
  if (status.status !== 0) {
    throw new ConfigError(
      `Sous could not read the checkout at ${directory}.\n` +
        (status.stderr.length > 0 ? `  git said: ${status.stderr}\n` : "") +
        `  Check that it is still a git checkout, then run the command again.`
    );
  }

  const examined = branch ?? currentBranch(directory, options);
  const tip = examined === undefined ? "HEAD" : `refs/heads/${examined}`;
  if (!refExists(tip)) {
    throw new ConfigError(
      `The checkout at ${directory} has no branch named '${examined}'.\n` +
        `  Name a branch it has with '--branch', or leave the flag off to use the one ` +
        `that is checked out.`
    );
  }

  const baseBranch = defaultBranch(directory, options);
  const baseRef =
    baseBranch !== undefined && refExists(`refs/remotes/${UPSTREAM_REMOTE}/${baseBranch}`)
      ? `refs/remotes/${UPSTREAM_REMOTE}/${baseBranch}`
      : undefined;

  const pushedCopies =
    examined === undefined
      ? []
      : [UPSTREAM_REMOTE, FORK_REMOTE]
          .map((remote) => `${remote}/${examined}`)
          .filter((copy) => refExists(`refs/remotes/${copy}`));

  const commitsNotIn = (exclude: string[]): string[] => {
    const args = ["log", "--oneline", "--no-decorate", tip];
    // With no upstream default branch to measure against, a commit counts as
    // the branch's own when no remote holds it.
    if (exclude.length === 0) args.push("--not", "--remotes");
    else args.push("--not", ...exclude);
    const result = git(args);
    return result.status === 0 ? lines(result.stdout) : [];
  };

  const base = baseRef === undefined ? [] : [baseRef];
  const ahead = commitsNotIn(base);
  const unpushed =
    pushedCopies.length === 0
      ? ahead
      : commitsNotIn([...base, ...pushedCopies.map((copy) => `refs/remotes/${copy}`)]);

  return {
    ...(examined === undefined ? {} : { branch: examined }),
    ...(baseBranch === undefined ? {} : { baseBranch }),
    uncommitted: lines(status.stdout),
    ahead,
    unpushed,
    pushedCopies,
  };
}

/**
 * Whether a branch has something to propose.
 *
 * - `nothing`: it holds nothing a proposal lacks, so there is nothing to submit.
 * - `pending`: it holds work no proposal carries yet.
 * - `lookup`: everything on it was pushed, so only the proposal itself can say
 *   whether that work is proposed; the caller has to look it up.
 */
export type PendingVerdict =
  | { kind: "nothing"; reason: string }
  | { kind: "pending"; reason: string }
  | { kind: "lookup"; reason: string };

/**
 * Judges what `pendingWork` found, without asking the repository host anything.
 *
 * assessPendingWork({ branch: "fix", baseBranch: "main", uncommitted: [], ahead: [],
 *   unpushed: [], pushedCopies: [] })
 * // -> { kind: "nothing", reason: "The branch 'fix' holds no commits that origin/main lacks, ..." }
 *
 * @param work - What the checkout's branch holds.
 */
export function assessPendingWork(work: PendingWork): PendingVerdict {
  const branch = work.branch === undefined ? "the checked-out commit" : `the branch '${work.branch}'`;
  const Branch = capitalize(branch);
  const base =
    work.baseBranch === undefined ? "any remote" : `${UPSTREAM_REMOTE}/${work.baseBranch}`;

  if (work.uncommitted.length > 0) {
    return {
      kind: "pending",
      reason: `The checkout holds ${count(work.uncommitted.length, "uncommitted change")}.`,
    };
  }
  if (work.ahead.length === 0) {
    return {
      kind: "nothing",
      reason: `${Branch} holds no commits that ${base} lacks, so there is nothing to submit.`,
    };
  }
  if (work.unpushed.length > 0) {
    return {
      kind: "pending",
      reason:
        `${Branch} holds ${count(work.unpushed.length, "commit")} that ` +
        (work.pushedCopies.length === 0
          ? "has never been pushed"
          : `${work.pushedCopies.join(" and ")} lacks`) +
        `, so no proposal carries ${work.unpushed.length === 1 ? "it" : "them"} yet.`,
    };
  }
  return {
    kind: "lookup",
    reason: `Every commit on ${branch} was pushed to ${work.pushedCopies.join(" and ")}.`,
  };
}

/**
 * Judges a pushed branch by its proposal: an open proposal already carries
 * everything, and so does a merged one; with no proposal, or one closed
 * without being merged, the pushed commits are not proposed.
 *
 * assessProposal("fix", undefined, "pull request")
 * // -> { kind: "pending", reason: "Every commit on the branch 'fix' was pushed, but no pull request is open for it." }
 *
 * @param branch - The branch.
 * @param proposal - The branch's proposal, when it has one.
 * @param noun - What the provider calls a proposal.
 */
export function assessProposal(
  branch: string,
  proposal: ProposalSummary | undefined,
  noun: string
): PendingVerdict {
  if (proposal === undefined) {
    return {
      kind: "pending",
      reason: `Every commit on the branch '${branch}' was pushed, but no ${noun} is open for it.`,
    };
  }
  switch (proposal.state) {
    case "open":
      return {
        kind: "nothing",
        reason:
          `Every commit on the branch '${branch}' is already in its open ${noun}` +
          `${proposal.url === undefined ? "" : `, ${proposal.url}`}.`,
      };
    case "merged":
      return {
        kind: "nothing",
        reason:
          `The ${noun} for the branch '${branch}' was merged` +
          `${proposal.url === undefined ? "" : `: ${proposal.url}`}.`,
      };
    default:
      return {
        kind: "pending",
        reason:
          `The ${noun} for the branch '${branch}' was closed without being merged, so no ` +
          `open ${noun} carries its commits.`,
      };
  }
}

/** "1 commit", "3 commits". */
function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

/** The text with its first letter in capitals. */
function capitalize(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}
