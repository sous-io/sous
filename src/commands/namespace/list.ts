/**
 * `sous namespace list`.
 *
 * Shows every namespace published by the repositories this project trusts, how
 * many recipes each one holds, and how much of it the project subscribes to. It
 * reads only the indexes sous already has on disk by default, so it works
 * offline; a repository whose index has never been fetched is named at the end
 * rather than being silently left out. `--latest` reads the indexes from
 * upstream instead, without saving them, and `--installed` narrows the listing
 * to the namespaces the lockfile pins a recipe from.
 */

import { BaseCommand } from "../../base-command.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import { loadCatalogContext } from "../../lib/repos/catalog-inputs.js";
import { listNamespaces, narrowToInstalled } from "../../lib/repos/catalog.js";
import {
  INDENT,
  describeCoverage,
  describeIndexSource,
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

  static examples = [
    "<%= config.bin %> namespace list",
    "<%= config.bin %> namespace list --installed",
  ];

  static flags = { ...BaseCommand.baseFlags, ...browsingFlags() };

  async run(): Promise<void> {
    const { flags } = await this.parse(NamespaceList);

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      Reading: describeIndexSource(flags.latest),
      ...(flags.installed ? { Showing: "only what this project has installed" } : {}),
    });

    heading(
      flags.installed
        ? "Namespaces this project has installed recipes from"
        : "Namespaces in the repositories this project trusts"
    );

    const service = subscriptionServiceFor({
      configContext: this.configContext,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    const { inputs, notFetched, notChecked } = await loadCatalogContext({
      service,
      sousDir: this.configContext.sousDir,
      settings: this.settings,
      latest: flags.latest,
    });

    // Narrowed to what is installed, a namespace's recipe count is the number
    // of its recipes the project has installed, and the column says so.
    const listings = listNamespaces(flags.installed ? narrowToInstalled(inputs) : inputs);
    const columns = flags.installed
      ? COLUMNS.map((column) =>
          column.key === "recipes" ? { ...column, header: "Installed" } : column
        )
      : COLUMNS;

    blankLine();

    if (listings.length === 0) {
      paragraph(
        inputs.repos.length === 0
          ? "Sous has read no repository index for this project, so there are no " +
            "namespaces to show."
          : flags.installed
            ? "This project has installed no recipe from the repositories it trusts."
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

      for (const line of renderTable(columns, rows, { indent: INDENT })) {
        log(indent(line, INDENT));
      }
    }

    printBrowsingNotes({ notFetched, notChecked });

    footer();
  }
}
