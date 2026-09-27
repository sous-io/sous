import { Args, Command, Flags } from "@oclif/core";
import { discoverConfig, refreshDiscoveredConfig } from "../../lib/config-discovery.js";
import { loadEnvFiles } from "../../lib/env-local.js";
import { isInteractive } from "../../lib/interactive.js";
import { enabledRepos } from "../../lib/repos/defaults.js";
import {
  findRepoRoot,
  renderChangelog,
  submitRepo,
  type SubmitResult,
} from "../../lib/repos/release/index.js";
import {
  findSubmitCheckout,
  type SubmitProject,
} from "../../lib/repos/release/submit-checkout.js";
import { submitQuestions } from "../../lib/repos/release/submit-questions.js";
import type { ProposalStatus } from "../../lib/repos/providers/provider.js";
import { loadSettings } from "../../lib/settings.js";
import { reportCommandError } from "../../utils/command-errors.js";
import { confirmationFlag, nonInteractiveFlag } from "../../utils/flags.js";
import {
  BULLET,
  blankLine,
  dryRunNotice,
  footer,
  header,
  log,
  note,
  paragraph,
  section,
  showCommandVars,
  showVariables,
  warning,
} from "../../utils/formatting.js";

/**
 * `sous repo submit` carries a proposed change to a recipe repository's
 * maintainers through its whole life: it opens the proposal, updates it when
 * there is more to send, reports where it stands, and starts the next one once
 * it was merged.
 *
 * Like `sous repo init` and `sous repo release`, this command does NOT extend
 * BaseCommand: it runs inside a RECIPE repository, which is not a sous project.
 * It can also be run from a project, naming a repository the project links, and
 * then looks for the project's config itself, optionally: finding none is not a
 * failure while the working directory is inside a recipe repository.
 *
 * Submitting never publishes and never writes to a repository directly. Sous
 * validates first, then hands the fork, branch and pull request mechanics to the
 * provider's own command line tool, which already holds the contributor's
 * credentials. Every step is printed before it runs, so a failure halfway
 * through leaves no doubt about what did happen.
 */
export default class RepoSubmit extends Command {
  static description =
    "Propose a recipe repository's changes to its maintainers, and follow the proposal through";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["repos:submit"];

  static examples = [
    '<%= config.bin %> repo submit --title "Add a linting recipe" --body "Adds lint rules."',
    "<%= config.bin %> repo submit sous-recipes",
    "<%= config.bin %> repo submit --status",
    "<%= config.bin %> repo submit --commit --yes --title \"Fix a typo\" --body \"Fixes it.\"",
    "<%= config.bin %> repo submit --dry-run",
  ];

  static args = {
    repo: Args.string({
      description: "The linked repository to propose a change from, when run inside a project",
      required: false,
    }),
  };

  static flags = {
    title: Flags.string({
      description: "The proposal's title; required for a new proposal, and replaces an open one's",
    }),
    body: Flags.string({
      description:
        "The proposal's description; required for a new proposal, and replaces an open one's",
    }),
    branch: Flags.string({
      description: "The branch to work with, instead of the one that is checked out",
    }),
    status: Flags.boolean({
      description: "Only report where the branch's proposal stands",
      default: false,
    }),
    commit: Flags.boolean({
      description: "Commit uncommitted changes for you, after listing them and asking once",
      default: false,
    }),
    draft: Flags.boolean({
      description: "Open a new proposal as a draft",
      default: false,
    }),
    yes: confirmationFlag(),
    "dry-run": Flags.boolean({
      description: "Check everything and print the plan without writing or sending anything",
      default: false,
    }),
    // This command does not extend BaseCommand, so it declares the global
    // non-interactive flag itself; the rule is the same everywhere.
    "non-interactive": nonInteractiveFlag(),
  };

  async init(): Promise<void> {
    await super.init();
    header();
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RepoSubmit);
    const dryRun = flags["dry-run"];
    const interactive = isInteractive();
    const cwd = process.cwd();

    showCommandVars({
      "Working directory": cwd,
      Repository: args.repo ?? "(the one the working directory is in)",
      Branch: flags.branch ?? "(the one that is checked out)",
      Mode: flags.status ? "Status only" : dryRun ? "Dry run" : "Propose",
    });

    const checkout = await findSubmitCheckout({
      cwd,
      ...(args.repo === undefined ? {} : { repo: args.repo }),
      ...(await this.projectFor(cwd, args.repo)),
      interactive,
    });

    section("The checkout");
    showVariables({
      Checkout: checkout.rootDir,
      ...(checkout.repo === undefined ? {} : { Repository: checkout.repo }),
    });
    blankLine();
    note(checkout.reason);
    for (const entry of checkout.notes) note(entry);

    section(flags.status ? "Looking the proposal up" : "Proposing a change");

    const result = await submitRepo({
      rootDir: checkout.rootDir,
      ...(flags.title === undefined ? {} : { title: flags.title }),
      ...(flags.body === undefined ? {} : { body: flags.body }),
      ...(flags.branch === undefined ? {} : { branch: flags.branch }),
      statusOnly: flags.status,
      commit: flags.commit,
      draft: flags.draft,
      dryRun,
      questions: submitQuestions({ interactive, yes: flags.yes }),
      onStep: (message) => log(`  ${message}`),
      onNotice: (message) => (dryRun ? dryRunNotice(message) : note(message)),
      onWarning: (message) => warning(message),
    });

    this.report(result);
    footer();
  }

  /**
   * The project around the working directory, when the run needs one: always
   * when a repository was named, and otherwise only when the working directory
   * is not a recipe repository itself (the checkout finder decides that; a
   * project found here is simply handed to it). A project whose config does not
   * load is an error, because the run cannot say what the argument names.
   *
   * @param cwd - The working directory.
   * @param repo - The repository the command line named, when it named one.
   */
  private async projectFor(
    cwd: string,
    repo: string | undefined
  ): Promise<{ project?: SubmitProject }> {
    const discovered = discoverConfig(cwd, undefined);
    if (discovered === null) return {};
    if (repo === undefined && insideRecipeRepo(cwd)) return {};

    loadEnvFiles(discovered.sousDir);
    const refreshed = refreshDiscoveredConfig(discovered);
    const settings = await loadSettings(refreshed);
    return { project: { sousDir: refreshed.sousDir, repos: enabledRepos(settings) } };
  }

  /**
   * Prints what the run did, or would do, as a key and value list followed by
   * one sentence, and the changelog when one was generated.
   *
   * @param result - What the submission reported.
   */
  private report(result: SubmitResult): void {
    const noun = result.proposalNoun;

    if (result.outcome === "cancelled") {
      blankLine();
      log("  Nothing was written and nothing was sent.");
      return;
    }

    if (result.outcome === "status") {
      section(`The ${noun} for '${result.branch}'`);
      if (result.status === undefined) {
        showVariables({ Repository: `${result.repo.owner}/${result.repo.name}`, Branch: result.branch });
        blankLine();
        paragraph(`The branch '${result.branch}' has no ${noun}.`);
        return;
      }
      showVariables(statusFacts(result, result.status));
      return;
    }

    if (result.changelog !== undefined) {
      section("What merging this changes");
      printChangelog(renderChangelog(result.changelog));
    }

    const heading =
      result.outcome === "created"
        ? result.dryRun
          ? `The ${noun} this would open`
          : `The ${noun} that was opened`
        : result.dryRun
          ? `The ${noun} this would update`
          : `The ${noun} for '${result.branch}'`;
    section(heading);

    showVariables({
      Provider: result.provider,
      Repository: `${result.repo.owner}/${result.repo.name}`,
      Branch: result.branch,
      "Target branch": result.baseBranch,
      "Pushed to": result.dryRun ? "(nothing was pushed)" : result.pushedTo,
      "Through a fork": result.usedFork,
      ...(result.title === undefined ? {} : { Title: result.title }),
      ...(result.committed === undefined ? {} : { Committed: result.committed.join(", ") }),
      Address: result.url ?? (result.dryRun ? "(not opened yet)" : "(the provider printed no address)"),
    });

    if (result.status !== undefined && !result.dryRun) {
      blankLine();
      showVariables(statusFacts(result, result.status));
    }

    blankLine();
    if (result.dryRun) {
      log("  Nothing was written and nothing was sent.");
    } else if (result.outcome === "created") {
      paragraph(
        `The ${noun} is open for review. The maintainers decide what happens next; sous ` +
          `never publishes on their behalf.`
      );
    } else if (result.outcome === "updated") {
      paragraph(`The ${noun} was updated with what this run sent.`);
    } else {
      paragraph(`There was nothing new to send, so the ${noun} was left as it was.`);
    }
  }

  /**
   * Renders a configuration error as a plain, readable message rather than an
   * oclif stack trace, matching what BaseCommand does for every other command.
   * An error raised because a question could not be asked also gets this
   * command's own help underneath it.
   */
  protected async catch(error: Error & { exitCode?: number }): Promise<unknown> {
    const exitCode = await reportCommandError(this, error);
    if (exitCode === undefined) return super.catch(error);
    return this.exit(exitCode);
  }
}

/**
 * Prints the Markdown changelog for a terminal: the heading is already the
 * section's, emphasis and code marks are dropped, a list item becomes a real
 * bullet, and every line is wrapped.
 *
 * @param markdown - The changelog as it goes into the proposal.
 */
function printChangelog(markdown: string): void {
  const lines = markdown.split("\n").slice(2);
  for (const raw of lines) {
    const line = raw.replace(/\*\*/g, "").replace(/`/g, "");
    if (line.trim().length === 0) {
      blankLine();
    } else if (line.startsWith("- ")) {
      paragraph(`${BULLET} ${line.slice(2)}`, { indent: 4, hangingIndent: 2 });
    } else {
      paragraph(line);
    }
  }
}

/** True when the directory is inside a recipe repository. */
function insideRecipeRepo(cwd: string): boolean {
  try {
    findRepoRoot(cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * The facts about where a proposal stands, as a key and value list.
 *
 * @param result - The submission, for the repository and the noun.
 * @param status - What the provider reported.
 */
function statusFacts(result: SubmitResult, status: ProposalStatus): Record<string, unknown> {
  const { proposal } = status;
  const state =
    proposal.state === "open"
      ? proposal.draft
        ? "open, as a draft"
        : "open"
      : proposal.state === "merged"
        ? "merged"
        : "closed without being merged";
  return {
    [`The ${result.proposalNoun}`]: proposal.title,
    State: state,
    ...(status.review === undefined ? {} : { Review: status.review }),
    ...(status.checks === undefined
      ? {}
      : {
          Checks:
            `${status.checks.passed} passed, ${status.checks.failed} failed, ` +
            `${status.checks.pending} still running`,
        }),
    ...(status.mergeable === undefined
      ? {}
      : { Mergeable: status.mergeable ? "yes" : "no, it conflicts with its target branch" }),
    ...(proposal.url === undefined ? {} : { Address: proposal.url }),
  };
}
