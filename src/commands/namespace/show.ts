/**
 * `sous namespace show <ref>`.
 *
 * Shows one namespace in full: the repository publishing it, what that
 * repository says it is for, how much of it this project subscribes to, and
 * every recipe in it with its latest version, its pinned version and its own
 * subscription state. It reads only the indexes sous already has on disk,
 * unless `--latest` asks it to read upstream (which saves nothing); `--installed`
 * narrows the recipes to the ones the lockfile pins.
 */

import { Args } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import { loadCatalogContext } from "../../lib/repos/catalog-inputs.js";
import { describeInstalled, describeNamespace } from "../../lib/repos/catalog.js";
import {
  INDENT,
  describeCoverage,
  describeIndexSource,
  factIf,
  printBrowsingNotes,
  printFacts,
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

  static flags = { ...BaseCommand.baseFlags, ...browsingFlags() };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(NamespaceShow);

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      Namespace: args.ref,
      Reading: describeIndexSource(flags.latest),
      ...(flags.installed ? { Showing: "only what this project has installed" } : {}),
    });

    const service = subscriptionServiceFor({
      configContext: this.configContext,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    const { inputs, notChecked } = await loadCatalogContext({
      service,
      sousDir: this.configContext.sousDir,
      settings: this.settings,
      latest: flags.latest,
    });

    const detail = flags.installed
      ? describeInstalled(inputs, args.ref, describeNamespace, "namespace")
      : describeNamespace(inputs, args.ref);

    heading(`The namespace ${detail.namespace}`);
    blankLine();

    printFacts([
      { label: "Repository", lines: [detail.repo] },
      ...factIf("Location", detail.repoUrl),
      ...factIf("About", detail.description),
      {
        label: flags.installed ? "Installed recipes" : "Recipes",
        lines: [String(detail.recipes.length)],
      },
      { label: "Subscribed", lines: [describeCoverage(detail.subscribed)] },
    ]);

    blankLine();
    subheading(`Recipes in ${detail.namespace}`);
    blankLine();

    if (detail.recipes.length === 0) {
      paragraph(`The repository ${detail.repo} publishes no recipes in this namespace.`);
      footer();
      return;
    }

    for (const line of renderTable(
      recipeColumns({ installed: flags.installed }),
      recipeRows(detail.recipes),
      { indent: INDENT }
    )) {
      log(indent(line, INDENT));
    }

    printBrowsingNotes({
      notChecked: notChecked.filter((name) => name === detail.repo),
      anyLinked: detail.recipes.some((entry) => entry.linkedPath !== undefined),
    });

    footer();
  }
}
