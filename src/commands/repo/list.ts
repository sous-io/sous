/**
 * `sous repo list`.
 *
 * Shows every repository this project trusts, what it publishes, and whether it
 * is currently being read from a working copy instead of a published version.
 * By default it reads only what sous already has on disk: a repository whose
 * index has never been fetched says so in its own row rather than triggering a
 * download, so the command is safe to run offline. `--latest` reads each index
 * from upstream instead, saving nothing, and `--installed` narrows the listing
 * to the repositories the lockfile pins a recipe from, naming each one under
 * its row.
 */

import { Flags } from "@oclif/core";
import { color } from "@oclif/color";
import { BaseCommand } from "../../base-command.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import { readEffectiveLinks } from "../../lib/repos/links.js";
import { BUILT_IN_ADDED_BY } from "../../lib/repos/defaults.js";
import { requireProvider } from "../../lib/repos/providers/index.js";
import { readTrustedIndexes } from "../../lib/repos/catalog-inputs.js";
import {
  LINKED_REPO_NOTE,
  describeIndexSource,
  printBrowsingNotes,
} from "../../lib/repos/catalog-display.js";
import { renderTable, type TableColumn } from "../../utils/table.js";
import { browsingFlags } from "../../utils/flags.js";
import {
  footer,
  indent,
  log,
  note,
  paragraph,
  section,
  showCommandVars,
  wrapColumns,
  wrapText,
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
  { key: "recipes", header: "Recipes", kind: "number", priority: "low", minWidth: 11 },
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
    "<%= config.bin %> repo list --installed --latest",
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    ...browsingFlags(),
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
      Reading: describeIndexSource(flags.latest),
      ...(flags.installed ? { Showing: "only what this project has installed" } : {}),
    });

    section(
      flags.installed
        ? "Repositories this project has installed recipes from"
        : "Repositories this project trusts"
    );

    const service = subscriptionServiceFor({
      configContext: this.configContext,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    const repos = service.currentRepos();
    const lock = service.lockService.read();
    const names = Object.keys(repos)
      .sort()
      .filter(
        (name) =>
          !flags.installed ||
          Object.values(lock.recipes).some((locked) => locked.repo === name)
      );

    if (names.length === 0 && flags.installed && Object.keys(repos).length > 0) {
      paragraph("This project has installed no recipe from the repositories it trusts.");
      footer();
      return;
    }

    if (names.length === 0) {
      paragraph(
        "This project trusts no repositories yet. Add one with " +
          "'sous repo add <url>'; adding a repository is how you trust it."
      );
      footer();
      return;
    }

    const links = readEffectiveLinks(this.configContext.sousDir);
    const indexes = await readTrustedIndexes(service, { latest: flags.latest });
    const indexFor = new Map(indexes.repos.map((entry) => [entry.name, entry.index]));

    const rows = names.map((name) => {
      const entry = repos[name]!;
      const index = indexFor.get(name);
      const namespaces =
        index === undefined ? "not fetched" : Object.keys(index.namespaces).sort().join(", ");
      // A repository whose index has never been fetched says so in the cell
      // itself. The count is not unknown in any interesting sense; sous simply
      // has not downloaded the one file that holds it, and saying that in the
      // row saves a note under the table.
      const recipes =
        index === undefined ? "not fetched" : String(Object.keys(index.recipes).length);
      return {
        name,
        url: entry.url,
        provider: describeProvider(entry.url, entry.provider),
        origin: describeOrigin(entry.addedBy),
        namespaces: namespaces.length > 0 ? namespaces : "none",
        recipes,
        linked: links[name] === undefined ? "no" : `yes: ${links[name]!.path}`,
        installed: Object.entries(lock.recipes)
          .filter(([, locked]) => locked.repo === name)
          .map(([key, locked]) => `${key} ${locked.version}`)
          .sort()
          .join(", "),
      };
    });

    for (const line of renderTable(COLUMNS, rows, {
      indent: INDENT,
      rowNote: (row) => {
        const notes: string[] = [];
        if (flags.verbose) notes.push(`Namespaces: ${row.namespaces}`);
        if (flags.installed) notes.push(`Installed: ${row.installed}`);
        // Each note wraps under itself, inside the two indents it is printed at.
        const width = Math.max(20, wrapColumns() - INDENT * 2);
        return notes.length === 0
          ? undefined
          : notes
              .flatMap((text) => wrapText(text, width))
              .map((line) => color.gray(indent(line, INDENT)))
              .join("\n");
      },
    })) {
      log(indent(line, INDENT));
    }

    // The table says everything about each repository; what sits under it is
    // only what the rows could not: a repository upstream could not answer for,
    // and what a linked row means for the installed recipes it names.
    printBrowsingNotes({ notChecked: indexes.notChecked.filter((name) => names.includes(name)) });
    if (flags.installed && names.some((name) => links[name] !== undefined)) {
      note(LINKED_REPO_NOTE);
    }
    footer();
  }
}

/**
 * The identifier of the provider that actually handles a repository entry: the
 * one the entry names, otherwise the one that recognizes its URL. The column
 * reports the provider doing the work, not how sous arrived at it, so an entry
 * that leaves `provider` out still reads `local` or `github` rather than a note
 * about detection. An entry no provider can claim reads `unknown`; the listing
 * is a read-only view of what is on disk and refuses nothing.
 *
 * @param url - The repository entry's URL.
 * @param providerId - The provider the entry named, when it named one.
 */
function describeProvider(url: string, providerId: string | undefined): string {
  try {
    return requireProvider(url, providerId).id;
  } catch {
    return "unknown";
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
