/**
 * `sous recipe list`.
 *
 * Shows every recipe the repositories this project trusts publish, with the
 * latest published version, the version this project pins, and whether it is
 * subscribed. By default it reads only the indexes sous already has on disk, so
 * it works offline; a repository whose index has never been fetched is named at
 * the end rather than being silently left out. `--latest` reads the indexes
 * from upstream instead, without saving them, and `--installed` narrows the
 * listing to what the lockfile pins.
 */

import { BaseCommand } from "../../base-command.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import { loadCatalogContext } from "../../lib/repos/catalog-inputs.js";
import { listRecipes, narrowToInstalled } from "../../lib/repos/catalog.js";
import {
  INDENT,
  describeIndexSource,
  printBrowsingNotes,
  recipeColumns,
  recipeRows,
} from "../../lib/repos/catalog-display.js";
import { renderTable } from "../../utils/table.js";
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

export default class RecipeList extends BaseCommand {
  static description = "List the recipes the repositories this project trusts publish";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["recipes:list"];

  static examples = [
    "<%= config.bin %> recipe list",
    "<%= config.bin %> recipe list --installed --latest",
  ];

  static flags = { ...BaseCommand.baseFlags, ...browsingFlags() };

  async run(): Promise<void> {
    const { flags } = await this.parse(RecipeList);

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      Reading: describeIndexSource(flags.latest),
      ...(flags.installed ? { Showing: "only what this project has installed" } : {}),
    });

    heading(
      flags.installed
        ? "Recipes this project has installed"
        : "Recipes in the repositories this project trusts"
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

    const listings = listRecipes(flags.installed ? narrowToInstalled(inputs) : inputs);

    blankLine();

    if (listings.length === 0) {
      paragraph(
        inputs.repos.length === 0
          ? "Sous has read no repository index for this project, so there are no " +
            "recipes to show."
          : flags.installed
            ? "This project has installed no recipe from the repositories it trusts."
            : "The repositories this project trusts publish no recipes."
      );
    } else {
      for (const line of renderTable(
        recipeColumns({ installed: flags.installed }),
        recipeRows(listings),
        { indent: INDENT }
      )) {
        log(indent(line, INDENT));
      }
    }

    printBrowsingNotes({
      notFetched,
      notChecked,
      anyLinked: listings.some((entry) => entry.linkedPath !== undefined),
    });

    footer();
  }
}
