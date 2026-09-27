/**
 * `sous subscription list`.
 *
 * Prints every subscription this project declares: the ref, the version range
 * it resolves within, the versions its lockfile currently pins, the latest
 * version each of those recipes has published, where the subscription came
 * from, and whether it is switched on. Entries switched off with
 * `enabled: false` are listed too, because an opt-out is part of what a project
 * declares.
 *
 * By default it reads only the config, the lockfile and the cached indexes, so
 * it is safe offline and never downloads anything. `--latest` reads the latest
 * versions from upstream instead, saving nothing, and `--installed` narrows the
 * listing to the subscriptions the lockfile pins something for.
 */

import { BaseCommand } from "../../base-command.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import { BUILT_IN_ADDED_BY } from "../../lib/repos/defaults.js";
import { USER_ADDED_BY } from "../../lib/repos/trust.js";
import { loadCatalogContext } from "../../lib/repos/catalog-inputs.js";
import { listRecipes } from "../../lib/repos/catalog.js";
import {
  describeIndexSource,
  pinnedCell,
  printBrowsingNotes,
} from "../../lib/repos/catalog-display.js";
import { renderTable, type TableColumn } from "../../utils/table.js";
import { browsingFlags } from "../../utils/flags.js";
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
  { key: "latest", header: "Latest version", overflow: "wrap", priority: "medium", minWidth: 14 },
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

  static examples = [
    "<%= config.bin %> subscription list",
    "<%= config.bin %> subscription list --installed --latest",
  ];

  static flags = { ...BaseCommand.baseFlags, ...browsingFlags() };

  async run(): Promise<void> {
    const { flags } = await this.parse(SubscriptionList);

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      Reading: describeIndexSource(flags.latest),
      ...(flags.installed ? { Showing: "only what this project has installed" } : {}),
    });

    heading("Subscriptions");

    const service = subscriptionServiceFor({
      configContext: this.configContext,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    const listings = service
      .listSubscriptions()
      .filter((entry) => !flags.installed || entry.pinned.length > 0);

    blankLine();

    if (listings.length === 0) {
      paragraph(
        flags.installed
          ? "No subscription of this project has installed anything yet."
          : "This project subscribes to nothing yet."
      );
      footer();
      return;
    }

    // The latest version of each pinned recipe, from the repository the
    // lockfile says it came from; the linked checkout, when there is one.
    const { inputs, notChecked } = await loadCatalogContext({
      service,
      sousDir: this.configContext.sousDir,
      settings: this.settings,
      latest: flags.latest,
    });
    const published = new Map(
      listRecipes(inputs).map((recipe) => [`${recipe.repo}:${recipe.key}`, recipe])
    );
    const lock = inputs.lock;

    let anyLinked = false;
    const rows = listings.map((entry) => {
      const held = entry.pinned.map((pin) => {
        const recipe = published.get(`${lock.recipes[pin.key]?.repo}:${pin.key}`);
        if (recipe?.linkedPath !== undefined) anyLinked = true;
        return { ...pin, recipe };
      });
      return {
        key: entry.key,
        range: entry.range ?? "any version",
        pinned:
          held.length === 0
            ? describePinned([], entry.enabled)
            : held
                .map((pin) => `${pin.key} ${pinnedCell(pin.version, pin.recipe?.linkedPath)}`)
                .join(", "),
        latest: describeLatest(held.map((pin) => ({ key: pin.key, latest: pin.recipe?.latest }))),
        origin: describeOrigin(entry.addedBy),
        enabled: entry.enabled ? "yes" : "no",
      };
    });

    const columns = flags.installed
      ? COLUMNS.map((column) =>
          column.key === "pinned" ? { ...column, header: "Installed version" } : column
        )
      : COLUMNS;

    for (const line of renderTable(columns, rows, { indent: INDENT })) {
      log(indent(line, INDENT));
    }

    printBrowsingNotes({ notChecked, anyLinked });

    footer();
  }
}

/**
 * The versions the lockfile pins for one subscription. A namespace subscription
 * holds several recipes, so each is named with the version beside it.
 *
 * A subscription with nothing pinned has simply not been built yet, which is
 * what the cell says; the one exception is a subscription switched off, which
 * no build will pin.
 *
 * @param pinned - The locked recipes the subscription holds.
 * @param enabled - Whether the subscription is switched on.
 */
export function describePinned(
  pinned: Array<{ key: string; version: string }>,
  enabled: boolean
): string {
  if (pinned.length > 0) return pinned.map((entry) => `${entry.key} ${entry.version}`).join(", ");
  return enabled ? "pinned on first build" : "not pinned";
}

/**
 * The latest published version of each recipe a subscription holds. One held
 * recipe is the usual case, and it shows the version alone; several (a
 * namespace subscription) are each named with the version beside them. A
 * recipe no readable index publishes says so; a subscription holding nothing
 * yet has no latest version to show.
 *
 * describeLatest([{ key: "workflow/task-files", latest: "1.2.0" }])
 * // -> "1.2.0"
 *
 * @param held - Each held recipe, with its latest version when an index names one.
 */
export function describeLatest(held: Array<{ key: string; latest: string | undefined }>): string {
  if (held.length === 0) return "";
  const unknown = "not in any index sous has read";
  if (held.length === 1) return held[0]!.latest ?? unknown;
  return held
    .map((entry) => `${entry.key} ${entry.latest ?? unknown}`)
    .join(", ");
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
