/**
 * `sous repo search <text>`.
 *
 * Searches the cached index of every repository this project trusts: recipe
 * names, namespace names and descriptions. By default it reads only what is
 * already on disk, so it works offline and never downloads anything; a
 * repository whose index has not been fetched yet is named at the end rather
 * than silently left out of the results. `--latest` searches each index as
 * upstream serves it, saving nothing, and `--installed` searches only the
 * recipes the lockfile pins, showing the installed version.
 */

import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import { readTrustedIndexes } from "../../lib/repos/catalog-inputs.js";
import {
  LINKED_NOTE,
  describeIndexSource,
  pinnedCell,
} from "../../lib/repos/catalog-display.js";
import { readEffectiveLinks } from "../../lib/repos/links.js";
import { renderTable, type TableColumn } from "../../utils/table.js";
import { browsingFlags } from "../../utils/flags.js";
import {
  blankLine,
  footer,
  indent,
  log,
  note,
  paragraph,
  section,
  showCommandVars,
} from "../../utils/formatting.js";

/** How far every line of this command's output is indented. */
const INDENT = 2;

/**
 * The columns the results show. The recipe and its versions are why anybody ran
 * the search, so they stay however narrow the terminal is; the description takes
 * whatever room is left and wraps rather than being cut, because half a sentence
 * helps nobody.
 */
const COLUMNS: TableColumn[] = [
  { key: "key", header: "Recipe", kind: "path", overflow: "truncate", minWidth: 12 },
  { key: "versions", header: "Versions", overflow: "truncate", minWidth: 7 },
  { key: "repo", header: "Repository", overflow: "truncate", priority: "medium" },
  {
    key: "description",
    header: "What it is",
    overflow: "wrap",
    flex: 1,
    priority: "low",
    minWidth: 16,
  },
];

/** The column an `--installed` search adds: the version the lockfile pins. */
const INSTALLED_COLUMN: TableColumn = {
  key: "installed",
  header: "Installed",
  overflow: "truncate",
  minWidth: 9,
};

/** One recipe that matched, ready to be shown. */
type Match = {
  repo: string;
  key: string;
  description: string;
  versions: string[];
  /** The version the lockfile pins, when it pins this recipe from this repository. */
  installed?: string;
  /** The linked checkout builds read it from, when it is installed and its repository is linked. */
  linkedPath?: string;
};

export default class RepoSearch extends BaseCommand {
  static description =
    "Search the recipes every trusted repository publishes, by name or description";

  /**
   * Searching is the way into every other repository command, so it is also a
   * top-level `sous search` and is listed as one. `repos:search` is the plural
   * spelling of the topic.
   */
  static aliases = ["search", "repos:search"];

  static examples = [
    "<%= config.bin %> repo search task",
    "<%= config.bin %> repo search browser --limit 50",
    "<%= config.bin %> repo search task --installed --latest",
  ];

  static args = {
    text: Args.string({
      description: "The text to look for in a namespace, recipe name or description",
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    ...browsingFlags(),
    limit: Flags.integer({
      description: "How many matches to show",
      default: 25,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RepoSearch);
    const needle = args.text.trim().toLowerCase();

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      Searching: args.text,
      Reading: describeIndexSource(flags.latest),
      ...(flags.installed ? { Showing: "only what this project has installed" } : {}),
    });

    section("Recipes matching your search");

    const service = subscriptionServiceFor({
      configContext: this.configContext,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    const repos = Object.keys(service.currentRepos()).sort();
    const matches: Match[] = [];
    const indexes = await readTrustedIndexes(service, { latest: flags.latest });
    const { notFetched, notChecked } = indexes;
    const lock = service.lockService.read();
    const links = readEffectiveLinks(this.configContext.sousDir);

    for (const { name: repo, index } of indexes.repos) {
      for (const [key, recipe] of Object.entries(index.recipes)) {
        const locked = lock.recipes[key];
        const installed = locked?.repo === repo ? locked.version : undefined;
        if (flags.installed && installed === undefined) continue;

        const namespace = key.slice(0, key.indexOf("/"));
        const haystack = [
          key,
          recipe.description ?? "",
          index.namespaces[namespace]?.description ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(needle)) continue;

        matches.push({
          repo,
          key,
          description: recipe.description ?? "",
          versions: Object.keys(recipe.versions).sort(),
          ...(installed === undefined ? {} : { installed }),
          ...(installed === undefined || links[repo] === undefined
            ? {}
            : { linkedPath: links[repo]!.path }),
        });
      }
    }

    matches.sort((left, right) =>
      left.key === right.key
        ? left.repo.localeCompare(right.repo)
        : left.key.localeCompare(right.key)
    );

    // Whatever the results themselves could not say goes into one closing
    // summary, rather than a stack of separate notes under the table.
    const summary: string[] = [];

    if (matches.length === 0) {
      paragraph(
        repos.length === 0
          ? "This project trusts no repositories yet, so there is nothing to search. " +
            "Add one with 'sous repo add <url>'."
          : flags.installed
            ? `Nothing this project has installed matches '${args.text}'.`
            : `Nothing in the repositories this project trusts matches '${args.text}'.`
      );
    } else {
      const shown = matches.slice(0, flags.limit);
      const rows = shown.map((match) => ({
        key: match.key,
        repo: match.repo,
        versions: match.versions.join(", "),
        installed: pinnedCell(match.installed, match.linkedPath),
        description:
          match.description.length > 0 ? match.description : "no description published",
      }));

      // Narrowed to what is installed, the installed version sits right after
      // the recipe, ahead of every version the repository publishes.
      const columns = flags.installed
        ? [COLUMNS[0]!, INSTALLED_COLUMN, ...COLUMNS.slice(1)]
        : COLUMNS;

      for (const line of renderTable(columns, rows, { indent: INDENT })) {
        log(indent(line, INDENT));
      }

      if (matches.length > shown.length) {
        summary.push(
          `${matches.length - shown.length} more matches are not shown. Raise the ` +
            `number with '--limit'.`
        );
      }
    }

    if (notFetched.length > 0) {
      summary.push(
        `Nothing has been fetched from these repositories yet, so they were not ` +
          `searched: ${notFetched.join(", ")}.`
      );
    }

    if (notChecked.length > 0) {
      summary.push(
        `These repositories could not be reached, so they were searched as the cache ` +
          `has them and were not checked: ${notChecked.join(", ")}.`
      );
    }

    if (summary.length > 0) {
      blankLine();
      for (const line of summary) paragraph(line);
    }

    if (matches.slice(0, flags.limit).some((match) => match.linkedPath !== undefined)) {
      blankLine();
      note(LINKED_NOTE);
    }

    footer();
  }
}
