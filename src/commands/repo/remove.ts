/**
 * `sous repo remove <name>`: stop trusting a repository.
 *
 * The exact reverse of adding one. Adding a repository IS trusting it, so
 * removing the entry is how that trust is withdrawn, and everything the project
 * held through it goes with it: every subscription that resolves into it, every
 * recipe those subscriptions alone held, and the files those recipes compiled.
 *
 * Informed consent, never prevention: the command prints all of that before it
 * writes anything, asks once, and then does exactly what it described. The
 * checkout behind a link is never deleted, because it is somebody's working
 * copy and sous did not necessarily put it there.
 */

import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import { buildProjectOutputs } from "../../lib/build-service.js";
import { ConfigError } from "../../lib/errors.js";
import { resolveRootScope } from "../../lib/settings.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import { confirmationFlag } from "../../utils/flags.js";
import { renderTable, type TableColumn } from "../../utils/table.js";
import {
  blankLine,
  dryRunNotice,
  footer,
  heading,
  indent,
  log,
  showCommandVars,
  subheading,
} from "../../utils/formatting.js";

/** How far every line of this command's output is indented. */
const INDENT = 2;

/** The columns the report of what stayed behind shows. */
const STAYED_COLUMNS: TableColumn[] = [
  { key: "key", header: "Recipe", kind: "path", overflow: "truncate", minWidth: 12 },
  { key: "heldBy", header: "Still held by", overflow: "wrap", flex: 1, minWidth: 16 },
];

export default class RepoRemove extends BaseCommand {
  static description = "Stop trusting a repository, and remove everything it brought in";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["repos:remove"];

  static examples = [
    "<%= config.bin %> repo remove my-recipes",
    "<%= config.bin %> repo remove my-recipes --dry-run",
    "<%= config.bin %> repo remove my-recipes --yes",
  ];

  static args = {
    repo: Args.string({
      description: "The repository's short name, as this project records it",
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    // The only question this command asks is whether to go ahead with what it
    // has just described, so the shared confirmation flag answers it.
    yes: confirmationFlag(),
    "dry-run": Flags.boolean({
      description: "Print what would be removed without writing anything",
      default: false,
    }),
    "no-build": Flags.boolean({
      description: "Remove the repository without rebuilding the project",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RepoRemove);
    const dryRun = flags["dry-run"];

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      Repository: args.repo,
      "Dry Run": dryRun,
    });

    // The heading is not followed by a blank line here: the plan that comes
    // next opens with one of its own.
    heading("Removing a repository");

    if (dryRun) dryRunNotice("Nothing will be written.");

    const service = subscriptionServiceFor({
      configContext: this.configContext,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    const outcome = await service.removeRepo({
      name: args.repo,
      yes: flags.yes,
      dryRun,
      // The output files a removed recipe wrote can only be named once the
      // `recipeOutputs` destinations have had their variables substituted.
      scope: resolveRootScope(this.settings, this.configContext),
    });

    blankLine();
    subheading("Lockfile");
    blankLine();
    if (outcome.diff.unchanged) {
      log(indent("Nothing changed; nothing was locked because of this repository."));
    } else {
      for (const line of outcome.diff.lines) log(indent(line));
    }

    if (outcome.stayed.length > 0) {
      blankLine();
      subheading("What stayed, and why");
      blankLine();
      const rows = outcome.stayed.map((entry) => ({
        key: entry.key,
        heldBy: entry.heldBy.join(", "),
      }));

      for (const line of renderTable(STAYED_COLUMNS, rows, { indent: INDENT })) {
        log(indent(line, INDENT));
      }
    }

    const rebuilding = !dryRun && !flags["no-build"];

    // The closing sentence names the build only when this run is not about to
    // do it, so nobody is told to run a command that is already running.
    const pruneHint = rebuilding
      ? ``
      : ` Run 'sous build' to prune what it used to write.`;

    blankLine();
    log(
      indent(
        dryRun
          ? "Nothing was written. Run the same command without '--dry-run' to remove it."
          : outcome.optedOut
            ? `The repository '${outcome.name}' is one sous provides itself, so it was ` +
              `switched off rather than deleted: this project's config now records ` +
              `'${outcome.name}: { enabled: false }'.${pruneHint}`
            : `This project no longer trusts '${outcome.name}'. Nothing is read from it ` +
              `any more, and its entry is gone from the repositories layer.${pruneHint}`
      )
    );

    footer();

    if (rebuilding) await this.rebuildProject(outcome.name);
  }

  /**
   * Rebuilds the project now that the repository has been removed, so the files
   * its recipes used to contribute are pruned before this command returns.
   *
   * The repositories and subscriptions both live in managed `conf.d/` layers, so
   * the settings loaded when this command started no longer describe the
   * project; they are reloaded before the build, or it would compile the old
   * recipe set straight back onto disk. A build that fails leaves the removal in
   * place, because it is already written and locked; the message says so and
   * names the command to run once the cause is fixed.
   *
   * @param name - The repository that was just removed, for the failure message.
   */
  private async rebuildProject(name: string): Promise<void> {
    await this.reloadDiscoveredConfig();

    heading("Building the project");

    const succeeded = await buildProjectOutputs(this.settings, this.configContext);

    footer();

    if (!succeeded) {
      throw new ConfigError(
        `The repository '${name}' was removed, but the build that followed it failed, ` +
          `so this project may still hold files its recipes used to write. The removal ` +
          `itself is recorded and locked; fix what the build reported above and run ` +
          `'sous build' again.`
      );
    }
  }
}
