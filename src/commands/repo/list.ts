/**
 * `sous repo list`.
 *
 * Shows every repository this project trusts, what it publishes, and whether it
 * is currently being read from a working copy instead of a published version.
 * It reads only what sous already has on disk: a repository whose index has
 * never been fetched is listed with its counts unknown rather than triggering a
 * download, so the command is safe to run offline.
 */

import { BaseCommand } from "../../base-command.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import { readEffectiveLinks } from "../../lib/repos/links.js";
import { BUILT_IN_ADDED_BY } from "../../lib/repos/defaults.js";
import { renderTable } from "../../lib/vars/display.js";
import {
  blankLine,
  footer,
  heading,
  indent,
  log,
  showCommandVars,
} from "../../utils/formatting.js";

export default class RepoList extends BaseCommand {
  static description = "List the recipe repositories this project trusts";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["repos:list"];

  static examples = ["<%= config.bin %> repo list"];

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    await this.parse(RepoList);

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
    const cache = service.indexes;

    const rows = names.map((name) => {
      const entry = repos[name]!;
      const index = cache.readCached(name);
      const namespaces =
        index === undefined ? "not fetched yet" : Object.keys(index.namespaces).sort().join(", ");
      const recipes = index === undefined ? "unknown" : String(Object.keys(index.recipes).length);
      return [
        name,
        entry.url,
        entry.provider ?? "detected from the URL",
        describeOrigin(entry.addedBy),
        namespaces.length > 0 ? namespaces : "none",
        recipes,
        links[name] === undefined ? "no" : `yes: ${links[name]!.path}`,
      ];
    });

    for (const line of renderTable(
      ["Repository", "Location", "Provider", "Origin", "Namespaces", "Recipes", "Linked"],
      rows
    )) {
      log(indent(line));
    }

    blankLine();
    log(
      indent(
        "A repository whose index has not been fetched yet reports its namespaces and " +
          "recipe count as unknown. Run 'sous repo add <url>' again to refresh it."
      )
    );
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
  if (addedBy === undefined || addedBy === "user") return "you added it";
  return `required by ${addedBy}`;
}
