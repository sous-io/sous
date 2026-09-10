/**
 * `sous unsubscribe <ref>`.
 *
 * The exact reverse of `sous subscribe`, and refcounted: removing a subscription
 * removes what it alone brought in, and leaves alone anything another
 * subscription or another recipe still needs. Whatever stays is reported, with
 * who is holding it, so a removal that appears to do nothing explains itself.
 *
 * The repository the recipes came from stays trusted; withdrawing that is a
 * separate, deliberate act.
 */

import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../base-command.js";
import { subscriptionServiceFor } from "../lib/repos/subscription-service.js";
import { renderTable } from "../lib/vars/display.js";
import {
  blankLine,
  dryRunNotice,
  footer,
  heading,
  indent,
  log,
  showCommandVars,
  subheading,
} from "../utils/formatting.js";

export default class Unsubscribe extends BaseCommand {
  static description = "Remove a subscription, and everything only it brought in";

  static examples = [
    "<%= config.bin %> unsubscribe workflow/task-files",
    "<%= config.bin %> unsubscribe core",
    "<%= config.bin %> unsubscribe workflow/task-files --dry-run",
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
    const { args, flags } = await this.parse(Unsubscribe);
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
      for (const line of renderTable(
        ["Recipe", "Still held by"],
        outcome.stayed.map((entry) => [entry.key, entry.heldBy.join(", ")])
      )) {
        log(indent(line));
      }
    }

    blankLine();
    log(
      indent(
        dryRun
          ? "Nothing was written. Run the same command without '--dry-run' to remove it."
          : `The subscription to '${outcome.key}' is gone. The repositories it came ` +
              `from are still trusted; remove one of those deliberately if you want ` +
              `to withdraw that too. Run 'sous build' to prune what it used to write.`
      )
    );

    footer();
  }
}
