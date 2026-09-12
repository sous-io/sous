/**
 * `sous subscription list`.
 *
 * Prints every subscription this project declares: the ref, the version range
 * it resolves within, the versions its lockfile currently pins, where the
 * subscription came from, and whether it is switched on. Entries switched off
 * with `enabled: false` are listed too, because an opt-out is part of what a
 * project declares.
 *
 * It reads only the config and the lockfile, so it is safe offline and never
 * downloads anything.
 */

import { BaseCommand } from "../../base-command.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import { BUILT_IN_ADDED_BY } from "../../lib/repos/defaults.js";
import { USER_ADDED_BY } from "../../lib/repos/trust.js";
import { renderTable, type TableColumn } from "../../utils/table.js";
import {
  blankLine,
  footer,
  heading,
  indent,
  log,
  paragraph,
  showCommandVars,
} from "../../utils/formatting.js";

/** How far every line of this command's output is indented. */
const INDENT = 2;

/**
 * The columns the listing shows. What a project subscribed to, the range it
 * asked for and the versions it actually holds are the whole point of the
 * command, so all three stay whatever the terminal's width; where a
 * subscription came from and whether it is switched on give way first.
 */
const COLUMNS: TableColumn[] = [
  { key: "key", header: "Subscription", kind: "path", overflow: "truncate", minWidth: 12 },
  { key: "range", header: "Range", overflow: "truncate", minWidth: 7 },
  { key: "pinned", header: "Pinned version", flex: 1, minWidth: 14 },
  { key: "origin", header: "Origin", priority: "medium" },
  { key: "enabled", header: "Enabled", priority: "medium" },
];

export default class SubscriptionList extends BaseCommand {
  static description = "List the recipes and namespaces this project subscribes to";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["subscriptions:list"];

  static examples = ["<%= config.bin %> subscription list"];

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    await this.parse(SubscriptionList);

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
    });

    heading("Subscriptions");

    const service = subscriptionServiceFor({
      configContext: this.configContext,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    const listings = service.listSubscriptions();

    blankLine();

    if (listings.length === 0) {
      paragraph("This project subscribes to nothing yet.");
      footer();
      return;
    }

    const rows = listings.map((entry) => ({
      key: entry.key,
      range: entry.range ?? "any version",
      pinned: describePinned(entry.pinned),
      origin: describeOrigin(entry.addedBy),
      enabled: entry.enabled ? "yes" : "no",
    }));

    for (const line of renderTable(COLUMNS, rows, { indent: INDENT })) {
      log(indent(line, INDENT));
    }

    footer();
  }
}

/**
 * The versions the lockfile pins for one subscription. A namespace subscription
 * holds several recipes, so each is named with the version beside it.
 *
 * @param pinned - The locked recipes the subscription holds.
 */
function describePinned(pinned: Array<{ key: string; version: string }>): string {
  if (pinned.length === 0) return "nothing locked yet";
  return pinned.map((entry) => `${entry.key} ${entry.version}`).join(", ");
}

/**
 * Plain-language wording for a subscription entry's `addedBy` field.
 *
 * @param addedBy - What the entry recorded, when it recorded anything.
 */
function describeOrigin(addedBy: string | undefined): string {
  if (addedBy === BUILT_IN_ADDED_BY) return "built in";
  if (addedBy === undefined || addedBy === USER_ADDED_BY) return "user";
  return addedBy;
}
