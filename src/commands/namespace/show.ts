/**
 * `sous namespace show <ref>`.
 *
 * Shows one namespace in full: the repository publishing it, what that
 * repository says it is for, how much of it this project subscribes to, and
 * every recipe in it with its latest version, its pinned version and its own
 * subscription state. It reads only the indexes sous already has on disk.
 */

import { Args } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import { catalogContextFor } from "../../lib/repos/catalog-inputs.js";
import { describeNamespace } from "../../lib/repos/catalog.js";
import {
  INDENT,
  RECIPE_COLUMNS,
  describeCoverage,
  factIf,
  printFacts,
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
  subheading,
} from "../../utils/formatting.js";

export default class NamespaceShow extends BaseCommand {
  static description = "Show one namespace and every recipe the repository publishes in it";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["namespaces:show"];

  static examples = [
    "<%= config.bin %> namespace show workflow",
    "<%= config.bin %> namespace show sous-recipes:core",
  ];

  static args = {
    ref: Args.string({
      description: "A namespace, optionally written as 'repository:namespace'",
      required: true,
    }),
  };

  static flags = { ...BaseCommand.baseFlags };

  async run(): Promise<void> {
    const { args } = await this.parse(NamespaceShow);

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      Namespace: args.ref,
    });

    const service = subscriptionServiceFor({
      configContext: this.configContext,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    const { inputs } = catalogContextFor({
      service,
      sousDir: this.configContext.sousDir,
      settings: this.settings,
    });

    const detail = describeNamespace(inputs, args.ref);

    heading(`The namespace ${detail.namespace}`);
    blankLine();

    printFacts([
      { label: "Repository", lines: [detail.repo] },
      ...factIf("Location", detail.repoUrl),
      ...factIf("About", detail.description),
      { label: "Recipes", lines: [String(detail.recipes.length)] },
      { label: "Subscribed", lines: [describeCoverage(detail.subscribed)] },
    ]);

    blankLine();
    subheading(`Recipes in ${detail.namespace}`);
    blankLine();

    if (detail.recipes.length === 0) {
      log(indent(`The repository ${detail.repo} publishes no recipes in this namespace.`));
      footer();
      return;
    }

    for (const line of renderTable(RECIPE_COLUMNS, recipeRows(detail.recipes), {
      indent: INDENT,
    })) {
      log(indent(line, INDENT));
    }

    footer();
  }
}
