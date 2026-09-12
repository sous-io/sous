/**
 * `sous repo gc`.
 *
 * Collects the machine-wide recipe store back down to its size cap, evicting the
 * least recently used entries first. Everything this project's lockfile still
 * pins is protected, whatever that does to the total, because a cache that is
 * too large is a nuisance while evicting a pinned entry breaks a build.
 *
 * The store is disposable by design: everything in it is re-fetchable from the
 * pins in a lockfile, so an entry evicted here comes back on the next build that
 * needs it.
 */

import { Flags } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import { resolveStoreSettings } from "../../lib/repos/store/settings.js";
import type { StoreKey } from "../../lib/repos/store/contract.js";
import { renderTable, type TableColumn } from "../../utils/table.js";
import {
  blankLine,
  dryRunNotice,
  footer,
  indent,
  log,
  paragraph,
  section,
  showCommandVars,
  showVariables,
} from "../../utils/formatting.js";

/** How far every line of this command's output is indented. */
const INDENT = 2;

/**
 * The columns the eviction report shows: what was removed, and how much room it
 * was taking. Which repository it came from and when it was last read are the
 * details that step aside on a narrow terminal.
 */
const EVICTED_COLUMNS: TableColumn[] = [
  { key: "recipe", header: "Recipe", kind: "path", overflow: "truncate", minWidth: 12 },
  { key: "version", header: "Version", overflow: "truncate" },
  { key: "size", header: "Size", kind: "number" },
  { key: "repo", header: "Repository", overflow: "truncate", priority: "medium" },
  { key: "lastUsed", header: "Last used", priority: "low", flex: 1 },
];

/** Renders a byte count the way a person reads one. */
function describeSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export default class RepoGc extends BaseCommand {
  static description =
    "Collect the machine-wide recipe store back down to its size cap";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["repos:gc"];

  static examples = [
    "<%= config.bin %> repo gc",
    "<%= config.bin %> repo gc --dry-run",
    "<%= config.bin %> repo gc --max-bytes 268435456",
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    "max-bytes": Flags.integer({
      description:
        "The size cap to collect down to, instead of the one this project's config sets",
    }),
    "dry-run": Flags.boolean({
      description: "Print what would be evicted without removing anything",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(RepoGc);
    const dryRun = flags["dry-run"];

    const service = subscriptionServiceFor({
      configContext: this.configContext,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    const storeSettings = resolveStoreSettings(this.settings);
    const maxBytes = flags["max-bytes"] ?? storeSettings.maxBytes;

    showCommandVars({
      Project: this.projectLabel,
      Store: service.store.root,
      "Size cap": describeSize(maxBytes),
      "Dry Run": dryRun,
    });

    section("Collecting the recipe store");

    if (dryRun) {
      dryRunNotice("Nothing will be removed.");
      blankLine();
    }

    // Everything this project pins is protected. Other projects on this machine
    // pin things too, and their entries are re-fetchable, so this pass may evict
    // them; that is what makes the store disposable.
    const lock = service.lockService.read();
    const keep: StoreKey[] = Object.entries(lock.recipes).flatMap(([key, entry]) => {
      const identity = lock.repos[entry.repo]?.identity;
      if (identity === undefined) return [];
      const namespace = key.slice(0, key.indexOf("/"));
      return [
        {
          identity,
          namespace,
          name: key.slice(namespace.length + 1),
          version: entry.version,
        },
      ];
    });

    const report = await service.store.gc({ maxBytes, keep, dryRun });

    showVariables({
      "Entries before": String(report.evicted.length + report.kept.length),
      "Entries kept": String(report.kept.length),
      "Entries evicted": String(report.evicted.length),
      "Size before": describeSize(report.bytesBefore),
      "Size after": describeSize(report.bytesAfter),
    });

    if (report.evicted.length > 0) {
      blankLine();
      const rows = report.evicted.map((entry) => ({
        repo: entry.repo,
        recipe: `${entry.namespace}/${entry.name}`,
        version: entry.version,
        size: describeSize(entry.sizeBytes),
        lastUsed: entry.lastAccessAt,
      }));

      for (const line of renderTable(EVICTED_COLUMNS, rows, { indent: INDENT })) {
        log(indent(line, INDENT));
      }
    }

    blankLine();
    paragraph(
      report.evicted.length === 0
        ? "The store is already inside its size cap, so nothing was removed."
        : dryRun
          ? "Nothing was removed. Everything listed above is re-fetchable from the " +
            "lockfile that pins it."
          : "Everything removed is re-fetchable from the lockfile that pins it; the " +
            "next build that needs one will download it again."
    );

    footer();
  }
}
