/**
 * `sous repo search <text>`.
 *
 * Searches the cached index of every repository this project trusts: recipe
 * names, namespace names and descriptions. It reads only what is already on
 * disk, so it works offline and never downloads anything; a repository whose
 * index has not been fetched yet is named at the end rather than silently left
 * out of the results.
 */

import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import { renderTable, type TableColumn } from "../../utils/table.js";
import {
  blankLine,
  footer,
  indent,
  log,
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

/** One recipe that matched, ready to be shown. */
type Match = {
  repo: string;
  key: string;
  description: string;
  versions: string[];
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
  ];

  static args = {
    text: Args.string({
      description: "The text to look for in a namespace, recipe name or description",
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
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
    });

    section("Recipes matching your search");

    const service = subscriptionServiceFor({
      configContext: this.configContext,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    const repos = Object.keys(service.currentRepos()).sort();
    const matches: Match[] = [];
    const notFetched: string[] = [];

    for (const repo of repos) {
      const index = service.cachedIndex(repo);
      if (index === undefined) {
        notFetched.push(repo);
        continue;
      }

      for (const [key, recipe] of Object.entries(index.recipes)) {
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
          : `Nothing in the repositories this project trusts matches '${args.text}'.`
      );
    } else {
      const shown = matches.slice(0, flags.limit);
      const rows = shown.map((match) => ({
        key: match.key,
        repo: match.repo,
        versions: match.versions.join(", "),
        description:
          match.description.length > 0 ? match.description : "no description published",
      }));

      for (const line of renderTable(COLUMNS, rows, { indent: INDENT })) {
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

    if (summary.length > 0) {
      blankLine();
      for (const line of summary) log(indent(line));
    }

    footer();
  }
}
