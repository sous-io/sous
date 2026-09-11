/**
 * `sous repo list`.
 *
 * Shows every repository this project trusts, what it publishes, and whether it
 * is currently being read from a working copy instead of a published version.
 * It reads only what sous already has on disk: a repository whose index has
 * never been fetched is listed with its counts unknown rather than triggering a
 * download, so the command is safe to run offline.
 */

import { Flags } from "@oclif/core";
import { color } from "@oclif/color";
import { BaseCommand } from "../../base-command.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import { readEffectiveLinks } from "../../lib/repos/links.js";
import { BUILT_IN_ADDED_BY } from "../../lib/repos/defaults.js";
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
 * The columns the listing shows, widest-mattering first. The URL is the column
 * that steps aside on a narrow terminal: it is the longest and the least often
 * read, and its middle is what a cut gives up, so the host and the repository
 * name both survive.
 */
const COLUMNS: TableColumn[] = [
  { key: "name", header: "Repository", overflow: "truncate", minWidth: 8 },
  { key: "provider", header: "Provider", priority: "medium" },
  { key: "origin", header: "Origin" },
  {
    key: "linked",
    header: "Linked",
    kind: "path",
    overflow: "truncate",
    priority: "medium",
    minWidth: 6,
  },
  { key: "recipes", header: "Recipes", kind: "number", priority: "low" },
  {
    key: "url",
    header: "URL",
    kind: "url",
    overflow: "truncate",
    truncate: "middle",
    priority: "low",
    flex: 1,
    minWidth: 12,
  },
];

export default class RepoList extends BaseCommand {
  static description = "List the recipe repositories this project trusts";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["repos:list"];

  static examples = [
    "<%= config.bin %> repo list",
    "<%= config.bin %> repo list --verbose",
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    verbose: Flags.boolean({
      description: "Show the namespaces each repository publishes, under its row",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(RepoList);

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
    });

    heading("Repositories this project trusts");

    const service = subscriptionServiceFor({
      configContext: this.configContext,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    const repos = service.currentRepos();
    const names = Object.keys(repos).sort();

    blankLine();

    if (names.length === 0) {
      log(
        indent(
          "This project trusts no repositories yet. Add one with " +
            "'sous repo add <url>'; adding a repository is how you trust it."
        )
      );
      footer();
      return;
    }

    const links = readEffectiveLinks(this.configContext.sousDir);

    const rows = names.map((name) => {
      const entry = repos[name]!;
      const index = service.cachedIndex(name);
      const namespaces =
        index === undefined ? "not fetched yet" : Object.keys(index.namespaces).sort().join(", ");
      const recipes = index === undefined ? "unknown" : String(Object.keys(index.recipes).length);
      return {
        name,
        url: entry.url,
        provider: entry.provider ?? "detected from the URL",
        origin: describeOrigin(entry.addedBy),
        namespaces: namespaces.length > 0 ? namespaces : "none",
        recipes,
        linked: links[name] === undefined ? "no" : `yes: ${links[name]!.path}`,
      };
    });

    for (const line of renderTable(COLUMNS, rows, {
      indent: INDENT,
      rowNote: flags.verbose
        ? (row) => color.gray(indent(`Namespaces: ${row.namespaces}`, INDENT))
        : undefined,
    })) {
      log(indent(line, INDENT));
    }

    blankLine();
    log(
      indent(
        "A repository whose index has not been fetched yet reports its recipe count as " +
          "unknown. Run 'sous repo add <url>' again to refresh it."
      )
    );
    if (!flags.verbose) {
      log(
        indent(
          "Run 'sous repo list --verbose' to see the namespaces each repository publishes."
        )
      );
    }
    log(
      indent(
        "A repository whose origin is 'built in' is one sous provides itself. To stop " +
          "using it, write it into your own config with 'enabled: false'."
      )
    );

    footer();
  }
}

/**
 * Plain-language wording for a repository entry's `addedBy` field, so the table
 * says who wanted the repository rather than printing a bare marker value.
 *
 * @param addedBy - What the entry recorded, when it recorded anything.
 */
function describeOrigin(addedBy: string | undefined): string {
  if (addedBy === BUILT_IN_ADDED_BY) return "built in";
  if (addedBy === undefined || addedBy === "user") return "user";
  return `required by ${addedBy}`;
}
