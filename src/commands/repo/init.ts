import path from "node:path";
import { Args, Command, Flags } from "@oclif/core";
import { ConfigError, isConfigError, SOUS_VERSION } from "../../lib/settings.js";
import { scaffoldRepo } from "../../lib/repos/scaffold/index.js";
import { wantsHelp } from "../../lib/interactive.js";
import { printCommandHelpToStderr } from "../../utils/command-help.js";
import { nonInteractiveFlag } from "../../utils/flags.js";
import {
  displayErrorBlock,
  dryRunNotice,
  blankLine,
  footer,
  header,
  log,
  section,
  showCommandVars,
  showVars,
} from "../../utils/formatting.js";

/**
 * `sous repo init` scaffolds a new recipe repository.
 *
 * This is the one repo command that does NOT extend BaseCommand. Every other
 * command needs a discovered project config; this one creates a repository,
 * which by definition is not a sous project and usually has no `.sous/`
 * directory anywhere above it. Requiring discovery here would mean the command
 * could only run inside an unrelated project, which is exactly backwards.
 */
export default class RepoInit extends Command {
  static description = "Create a new sous recipe repository in a directory";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["repos:init"];

  static examples = [
    "<%= config.bin %> repo init",
    "<%= config.bin %> repo init ./my-recipes",
    "<%= config.bin %> repo init ./my-recipes --name team-recipes --namespace workflow",
    "<%= config.bin %> repo init ./my-recipes --dry-run",
  ];

  static args = {
    directory: Args.string({
      description: "Directory to create the repository in (defaults to the current one)",
      required: false,
    }),
  };

  static flags = {
    name: Flags.string({
      description:
        "Short name for the repository (defaults to the directory's own name)",
    }),
    namespace: Flags.string({
      description:
        "Name of the one namespace to declare (defaults to the repository's name)",
    }),
    force: Flags.boolean({
      description: "Write the scaffold over a repository that already exists",
      default: false,
    }),
    "dry-run": Flags.boolean({
      description: "Print the files that would be written without writing them",
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
    const { args, flags } = await this.parse(RepoInit);
    const directory = path.resolve(process.cwd(), args.directory ?? ".");

    showCommandVars({
      Directory: directory,
      Name: flags.name ?? "(from the directory name)",
      Namespace: flags.namespace ?? "(same as the repository name)",
      "Dry Run": flags["dry-run"],
    });

    section("Creating a recipe repository");

    const result = scaffoldRepo({
      directory,
      name: flags.name,
      namespace: flags.namespace,
      force: flags.force,
      dryRun: flags["dry-run"],
      sousVersion: SOUS_VERSION,
    });

    for (const file of result.files) {
      if (result.dryRun) dryRunNotice(`would write ${file}`);
      else log(`  wrote ${file}`);
    }

    section("What to do next");
    showVars({
      Repository: result.name,
      Namespace: result.namespace,
      "Example recipe": path.join(
        "recipes",
        result.namespace,
        "example",
        "sous.recipe.yaml"
      ),
    });

    blankLine();
    log("  Edit the example recipe, or copy its folder to start another one.");
    log("  Every recipe folder must also be listed under 'recipes' in sous.repo.yaml.");
    log("  Commit the repository and push it, then add it to a project with");
    log("  'sous repo add <url>'. Adding a repository is what trusts it.");

    footer();
  }

  /**
   * Renders a configuration error as a plain, readable message rather than an
   * oclif stack trace, matching what BaseCommand does for every other command.
   * An error raised because a question could not be asked also gets this
   * command's own help underneath it.
   */
  protected async catch(error: Error & { exitCode?: number }): Promise<unknown> {
    if (isConfigError(error)) {
      displayErrorBlock((error as ConfigError).message);
      if (wantsHelp(error)) await printCommandHelpToStderr(this);
      return this.exit(1);
    }
    return super.catch(error);
  }
}
