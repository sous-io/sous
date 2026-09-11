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
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
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
      log(indent("Nothing changed; nothing was locked because of this subscription."));
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

    blankLine();
    log(
      indent(
        dryRun
          ? "Nothing was written. Run the same command without '--dry-run' to remove it."
          : outcome.optedOut
            ? `The subscription to '${outcome.key}' is one sous provides itself, so it ` +
              `was switched off rather than deleted: this project's config now records ` +
              `'${outcome.key}: { enabled: false }'. The repository it came from is still ` +
              `trusted. Run 'sous build' to prune what it used to write.`
            : `The subscription to '${outcome.key}' is gone. The repositories it came ` +
              `from are still trusted; remove one of those deliberately if you want ` +
              `to withdraw that too. Run 'sous build' to prune what it used to write.`
      )
    );

    footer();
  }
}
