/**
 * `sous lock show`.
 *
 * Prints the lockfile: every recipe this project pins, the version and the
 * repository it is pinned to, and who holds it. It reads the file and nothing
 * else, so it works offline and never writes.
 */

import { BaseCommand } from "../../base-command.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import { PROJECT_HOLDER } from "../../lib/repos/formats/lockfile.js";
import { renderTable, type TableColumn } from "../../utils/table.js";
import {
  blankLine,
  footer,
  heading,
  indent,
  log,
  showCommandVars,
} from "../../utils/formatting.js";

/** How far every line of this command's output is indented. */
const INDENT = 2;

/**
 * The columns the listing shows. The recipe and the version it is pinned at are
 * what a lockfile is for, so they stay whatever the terminal's width; the list
 * of holders takes the room that is left and wraps rather than being cut.
 */
const COLUMNS: TableColumn[] = [
  { key: "key", header: "Recipe", kind: "path", overflow: "truncate", minWidth: 12 },
  { key: "version", header: "Version", overflow: "truncate", minWidth: 7 },
  { key: "repo", header: "Repository", overflow: "truncate", priority: "medium" },
  {
    key: "heldBy",
    header: "Held by",
    overflow: "wrap",
    flex: 1,
    priority: "low",
    minWidth: 16,
  },
];

export default class LockShow extends BaseCommand {
  static description = "Show every recipe version this project's lockfile pins";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["locks:show"];

  static examples = ["<%= config.bin %> lock show"];

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    await this.parse(LockShow);

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
    });

    const service = subscriptionServiceFor({
      configContext: this.configContext,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    const lock = service.lockService.read();
    const keys = Object.keys(lock.recipes).sort();

    heading("Recipe versions this project pins");
    blankLine();

    if (keys.length === 0) {
      log(indent(`This project pins nothing yet. Its lockfile is ${service.lockService.filePath}.`));
      footer();
      return;
    }

    const rows = keys.map((key) => {
      const entry = lock.recipes[key]!;
      return {
        key,
        version: entry.version,
        repo: entry.repo,
        heldBy: entry.requestedBy.map(describeHolder).join(", "),
      };
    });

    for (const line of renderTable(COLUMNS, rows, { indent: INDENT })) {
      log(indent(line, INDENT));
    }

    blankLine();
    log(indent(`This project's lockfile is ${service.lockService.filePath}.`));

    footer();
  }
}

/**
 * Plain-language wording for one holder of a locked recipe: the project itself,
 * or the recipe that requires it.
 *
 * @param holder - What the lockfile recorded.
 */
function describeHolder(holder: string): string {
  return holder === PROJECT_HOLDER ? "this project" : holder;
}
