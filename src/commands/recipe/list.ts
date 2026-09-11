/**
 * `sous recipe list`.
 *
 * Shows every recipe the repositories this project trusts publish, with the
 * latest published version, the version this project pins, and whether it is
 * subscribed. It reads only the indexes sous already has on disk, so it works
 * offline; a repository whose index has never been fetched is named at the end
 * rather than being silently left out.
 */

import { BaseCommand } from "../../base-command.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import { catalogContextFor } from "../../lib/repos/catalog-inputs.js";
import { listRecipes } from "../../lib/repos/catalog.js";
import {
  INDENT,
  RECIPE_COLUMNS,
  recipeRows,
} from "../../lib/repos/catalog-display.js";
import { renderTable } from "../../utils/table.js";
import {
  blankLine,
  footer,
  heading,
  indent,
  log,
  showCommandVars,
} from "../../utils/formatting.js";

export default class RecipeList extends BaseCommand {
  static description = "List the recipes the repositories this project trusts publish";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["recipes:list"];

  static examples = ["<%= config.bin %> recipe list"];

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    await this.parse(RecipeList);

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
    });

    heading("Recipes in the repositories this project trusts");

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

    const listings = listRecipes(inputs);

    blankLine();

    if (listings.length === 0) {
      log(
        indent(
          inputs.repos.length === 0
            ? "Sous has read no repository index for this project, so there are no " +
                "recipes to show."
            : "The repositories this project trusts publish no recipes."
        )
      );
    } else {
      for (const line of renderTable(RECIPE_COLUMNS, recipeRows(listings), {
        indent: INDENT,
      })) {
        log(indent(line, INDENT));
      }
    }

    if (notFetched.length > 0) {
      blankLine();
      log(
        indent(
          `These repositories are trusted and their index has not been fetched yet, so ` +
            `nothing in them is listed: ${notFetched.join(", ")}.`
        )
      );
    }

    footer();
  }
}
