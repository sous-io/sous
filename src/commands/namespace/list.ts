/**
 * `sous namespace list`.
 *
 * Shows every namespace published by the repositories this project trusts, how
 * many recipes each one holds, and how much of it the project subscribes to. It
 * reads only the indexes sous already has on disk, so it works offline; a
 * repository whose index has never been fetched is named at the end rather than
 * being silently left out.
 */

import { BaseCommand } from "../../base-command.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import { catalogContextFor } from "../../lib/repos/catalog-inputs.js";
import { listNamespaces } from "../../lib/repos/catalog.js";
import { INDENT, describeCoverage } from "../../lib/repos/catalog-display.js";
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

/**
 * The columns the listing shows. The namespace and what a project has of it are
 * the point of the command, so they stay whatever the terminal's width; the
 * description takes the room that is left and wraps rather than being cut.
 */
const COLUMNS: TableColumn[] = [
  { key: "namespace", header: "Namespace", overflow: "truncate", minWidth: 10 },
  { key: "repo", header: "Repository", overflow: "truncate", priority: "medium" },
  { key: "recipes", header: "Recipes", kind: "number", priority: "medium" },
  { key: "subscribed", header: "Subscribed", priority: "medium" },
  {
    key: "description",
    header: "What it is",
    overflow: "wrap",
    flex: 1,
    priority: "low",
    minWidth: 16,
  },
];

export default class NamespaceList extends BaseCommand {
  static description = "List the namespaces the repositories this project trusts publish";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["namespaces:list"];

  static examples = ["<%= config.bin %> namespace list"];

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    await this.parse(NamespaceList);

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
    });

    heading("Namespaces in the repositories this project trusts");

    const service = subscriptionServiceFor({
      configContext: this.configContext,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    const { inputs, notFetched } = catalogContextFor({
      service,
      sousDir: this.configContext.sousDir,
      settings: this.settings,
    });

    const listings = listNamespaces(inputs);

    blankLine();

    if (listings.length === 0) {
      paragraph(
        inputs.repos.length === 0
          ? "Sous has read no repository index for this project, so there are no " +
            "namespaces to show."
          : "The repositories this project trusts publish no namespaces."
      );
    } else {
      const rows = listings.map((entry) => ({
        namespace: entry.namespace,
        repo: entry.repo,
        recipes: String(entry.recipeCount),
        subscribed: describeCoverage(entry.subscribed),
        description: entry.description ?? "no description published",
      }));

      for (const line of renderTable(COLUMNS, rows, { indent: INDENT })) {
        log(indent(line, INDENT));
      }
    }

    if (notFetched.length > 0) {
      blankLine();
      paragraph(
        `These repositories are trusted and their index has not been fetched yet, so ` +
          `nothing in them is listed: ${notFetched.join(", ")}.`
      );
    }

    footer();
  }
}
