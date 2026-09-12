import { Command, Flags } from "@oclif/core";
import { SOUS_VERSION } from "../../lib/settings.js";
import { findRepoRoot, submitRepo } from "../../lib/repos/release/index.js";
import { reportCommandError } from "../../utils/command-errors.js";
import { nonInteractiveFlag } from "../../utils/flags.js";
import {
  blankLine,
  dryRunNotice,
  footer,
  header,
  log,
  section,
  showCommandVars,
  showVariables,
} from "../../utils/formatting.js";

/**
 * `sous repo submit` proposes the committed changes in a recipe repository to
 * that repository's maintainers.
 *
 * Like `sous repo init` and `sous repo release`, this command does NOT extend
 * BaseCommand: it runs inside a RECIPE repository, which is not a sous project
 * and has no `.sous/` directory of its own.
 *
 * Submitting never publishes and never writes to a repository directly. Sous
 * validates first, then hands the fork, branch and pull request mechanics to the
 * provider's own command line tool, which already holds the contributor's
 * credentials. Every step is printed before it runs, so a failure halfway
 * through leaves no doubt about what did happen.
 */
export default class RepoSubmit extends Command {
  static description =
    "Propose this recipe repository's committed changes to its maintainers";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["repos:submit"];

  static examples = [
    "<%= config.bin %> repo submit",
    '<%= config.bin %> repo submit --title "Add a linting recipe"',
    "<%= config.bin %> repo submit --draft",
    "<%= config.bin %> repo submit --dry-run",
  ];

  static flags = {
    title: Flags.string({
      description: "Title for the proposal. Defaults to the last commit's subject.",
    }),
    body: Flags.string({
      description: "Body for the proposal. Defaults to a summary sous writes.",
    }),
    draft: Flags.boolean({
      description: "Open the proposal as a draft",
      default: false,
    }),
    "dry-run": Flags.boolean({
      description: "Check everything and print the plan without sending anything",
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
    const { flags } = await this.parse(RepoSubmit);
    const dryRun = flags["dry-run"];
    const rootDir = findRepoRoot(process.cwd());

    showCommandVars({
      Repository: rootDir,
      Title: flags.title ?? "(the last commit's subject)",
      Draft: flags.draft,
      "Dry Run": dryRun,
    });

    section("Proposing a change");

    const result = await submitRepo({
      rootDir,
      title: flags.title,
      body: flags.body,
      draft: flags.draft,
      dryRun,
      sousVersion: SOUS_VERSION,
      onStep: (message) => log(`  ${message}`),
      onNotice: (message) => (dryRun ? dryRunNotice(message) : log(`  ${message}`)),
    });

    section(dryRun ? "What would be proposed" : "What was proposed");
    showVariables({
      Provider: result.provider,
      Repository: `${result.repo.owner}/${result.repo.name}`,
      Branch: result.branch,
      "Target branch": result.baseBranch,
      "Pushed to": result.dryRun ? "(nothing was pushed)" : result.pushedTo,
      "Through a fork": result.usedFork,
      Title: result.title,
      Proposal: result.url ?? "(the provider printed no address)",
    });

    blankLine();
    if (result.dryRun) {
      log("  Nothing was sent. Run the command again without --dry-run to propose it.");
    } else {
      log("  The maintainers decide what happens next; sous never publishes on their");
      log("  behalf. Anything they ask for goes on the same branch, and the proposal");
      log("  updates itself when you push again.");
    }

    footer();
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
