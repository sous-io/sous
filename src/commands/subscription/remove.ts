/**
 * `sous subscription remove <ref>`, also reachable as `sous unsubscribe <ref>`.
 *
 * The exact reverse of adding a subscription, and refcounted: removing a subscription
 * removes what it alone brought in, and leaves alone anything another
 * subscription or another recipe still needs. Whatever stays is reported, with
 * who is holding it, so a removal that appears to do nothing explains itself.
 *
 * The repository the recipes came from stays trusted; withdrawing that is a
 * separate, deliberate act.
 */

import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import { buildProjectOutputs } from "../../lib/build-service.js";
import { ConfigError } from "../../lib/errors.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import { renderTable, type TableColumn } from "../../utils/table.js";
import {
  blankLine,
  dryRunNotice,
  footer,
  heading,
  indent,
  log,
  paragraph,
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

export default class SubscriptionRemove extends BaseCommand {
  static description = "Remove a subscription, and everything only it brought in";

  /**
   * `subscriptions:remove` is the plural spelling of the topic. `unsubscribe` is
   * the original spelling of this command and still works; it is hidden so the
   * top-level listing names the command once, under its topic.
   */
  static aliases = ["subscriptions:remove"];

  static hiddenAliases = ["unsubscribe"];

  static examples = [
    "<%= config.bin %> subscription remove workflow/task-files",
    "<%= config.bin %> subscription remove core",
    "<%= config.bin %> subscription remove workflow/task-files --dry-run",
  ];

  static args = {
    ref: Args.string({
      description: "What to unsubscribe from: 'namespace' or 'namespace/recipe'",
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    "dry-run": Flags.boolean({
      description: "Print what would be removed without writing anything",
      default: false,
    }),
    "no-build": Flags.boolean({
      description: "Change the subscription without rebuilding the project",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SubscriptionRemove);
    const dryRun = flags["dry-run"];

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      Unsubscribing: args.ref,
      "Dry Run": dryRun,
    });

    heading("Unsubscribing");

    if (dryRun) dryRunNotice("Nothing will be written.");

    const service = subscriptionServiceFor({
      configContext: this.configContext,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    const outcome = await service.unsubscribe({ ref: args.ref, dryRun });

    blankLine();
    subheading("Lockfile");
    blankLine();
    if (outcome.diff.unchanged) {
      paragraph("Nothing changed; nothing was locked because of this subscription.");
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

    // The closing sentence names the build only when this run is not about to do
    // it, so nobody is told to run a command that is already running.
    const pruneHint = rebuilding
      ? ``
      : ` Run 'sous build' to prune what it used to write.`;

    blankLine();
    paragraph(
      dryRun
        ? "Nothing was written. Run the same command without '--dry-run' to remove it."
        : outcome.optedOut
          ? `The subscription to '${outcome.key}' is one sous provides itself, so it ` +
            `was switched off rather than deleted: this project's config now records ` +
            `'${outcome.key}: { enabled: false }'. The repository it came from is ` +
            `still trusted.${pruneHint}`
          : `The subscription to '${outcome.key}' is gone. The repositories it came ` +
            `from are still trusted; remove one of those deliberately if you want ` +
            `to withdraw that too.${pruneHint}`
    );

    footer();

    if (rebuilding) await this.rebuildProject(outcome.key);
  }

  /**
   * Rebuilds the project now that the subscription has been removed, so the
   * files it used to contribute are pruned before this command returns.
   *
   * The subscription lives in a managed `conf.d/` layer, so the settings loaded
   * when this command started no longer describe the project; they are reloaded
   * before the build, or it would compile the old subscription set straight back
   * onto disk. A build that fails leaves the removal in place, because it is
   * already written and locked; the message says so and names the command to run
   * once the cause is fixed.
   *
   * @param key - The subscription that was just removed, for the failure message.
   */
  private async rebuildProject(key: string): Promise<void> {
    await this.reloadDiscoveredConfig();

    heading("Building the project");

    const succeeded = await buildProjectOutputs(this.settings, this.configContext);

    footer();

    if (!succeeded) {
      throw new ConfigError(
        `The subscription to '${key}' was removed, but the build that followed it ` +
          `failed, so this project may still hold files it used to write. The removal ` +
          `itself is recorded and locked; fix what the build reported above and run ` +
          `'sous build' again.`
      );
    }
  }
}
