/**
 * `sous subscription add <ref>`, also reachable as `sous subscribe <ref>`.
 *
 * Subscribing is how a recipe enters a project. The ref names a namespace (every
 * recipe in it, including ones published later) or one recipe, with an optional
 * version range:
 *
 *     sous subscription add workflow/task-files
 *     sous subscription add workflow/task-files@^1.2.0
 *     sous subscription add core
 *     sous subscription add my-recipes:workflow/task-files
 *
 * The whole dependency closure is resolved before anything is downloaded. If it
 * reaches a repository this project has not added, sous stops and asks about it
 * by name, showing which recipe requires it; a run with no terminal fails
 * instead, naming the command that grants the trust. Installs are whole or not
 * at all.
 */

import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import { formatAskReport } from "../../lib/vars/ask.js";
import { renderTable, type TableColumn } from "../../utils/table.js";
import {
  blankLine,
  dryRunNotice,
  footer,
  heading,
  indent,
  log,
  showCommandVars,
  subheading,
  warning,
} from "../../utils/formatting.js";
import { confirmationFlag } from "../../utils/flags.js";

/** How far every line of this command's output is indented. */
const INDENT = 2;

/**
 * The columns the installation report shows: what was installed, at what
 * version, and why it is there. The reason wraps rather than being cut, because
 * it is the answer to the question a reader is most likely to have.
 */
const INSTALLED_COLUMNS: TableColumn[] = [
  { key: "key", header: "Recipe", kind: "path", overflow: "truncate", minWidth: 12 },
  { key: "version", header: "Version", overflow: "truncate" },
  { key: "repo", header: "Repository", overflow: "truncate", priority: "medium" },
  { key: "why", header: "Why", overflow: "wrap", flex: 1, minWidth: 16 },
];

export default class SubscriptionAdd extends BaseCommand {
  static description =
    "Subscribe this project to a recipe, or to a whole namespace of them";

  /**
   * `subscriptions:add` is the plural spelling of the topic. `subscribe` is the
   * original spelling of this command and still works; it is hidden so the
   * top-level listing names the command once, under its topic.
   */
  static aliases = ["subscriptions:add"];

  static hiddenAliases = ["subscribe"];

  static examples = [
    "<%= config.bin %> subscription add workflow/task-files",
    "<%= config.bin %> subscription add workflow/task-files@^1.2.0",
    "<%= config.bin %> subscription add core",
    "<%= config.bin %> subscription add workflow/task-files --always-pull",
  ];

  static args = {
    ref: Args.string({
      description:
        "What to subscribe to: 'namespace', 'namespace/recipe', or either with an '@<range>'",
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    prerelease: Flags.boolean({
      description: "Let prerelease versions take part in version range matching",
      default: false,
    }),
    "always-pull": Flags.boolean({
      description:
        "Install a newer in-range version whenever one exists, rather than holding the locked one",
      default: false,
    }),
    // One flag answers both questions this command can ask: the trust question
    // for a repository it has to add, and the subscribe confirmation. `--trust`
    // is kept as a spelling of it because the trust ceremony reads naturally
    // with that word.
    yes: confirmationFlag({ extraAliases: ["trust"] }),
    "accept-first": Flags.boolean({
      description:
        "When a one-word ref matches several things, take the first one listed",
      default: false,
    }),
    "dry-run": Flags.boolean({
      description: "Print what would be installed without writing or downloading anything",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SubscriptionAdd);
    const dryRun = flags["dry-run"];

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      Subscribing: args.ref,
      "Dry Run": dryRun,
    });

    heading("Subscribing");

    if (dryRun) dryRunNotice("Nothing will be downloaded, written or asked.");

    const service = subscriptionServiceFor({
      configContext: this.configContext,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    const outcome = await service.subscribe({
      ref: args.ref,
      prerelease: flags.prerelease,
      alwaysPull: flags["always-pull"],
      trust: flags.yes,
      yes: flags.yes,
      acceptFirst: flags["accept-first"],
      dryRun,
    });

    blankLine();
    subheading(dryRun ? "What would be installed" : "What was installed");
    blankLine();

    const rows = outcome.resolved.map((recipe) => ({
      key: recipe.key,
      version: recipe.version,
      repo: recipe.repo,
      why: recipe.requestedBy.includes("project")
        ? "you subscribed to it"
        : recipe.kind === "subscribes"
          ? `co-subscribed by ${recipe.requestedBy.join(", ")}`
          : `needed by ${recipe.requestedBy.join(", ")}`,
    }));

    for (const line of renderTable(INSTALLED_COLUMNS, rows, { indent: INDENT })) {
      log(indent(line, INDENT));
    }

    if (outcome.trusted.length > 0) {
      blankLine();
      log(
        indent(
          `Repositories trusted along the way: ${outcome.trusted.join(", ")}. ` +
            `They are now recorded in this project's config, and your colleagues ` +
            `inherit them.`
        )
      );
    }

    blankLine();
    subheading("Lockfile");
    blankLine();
    if (outcome.diff.unchanged) {
      log(indent("Nothing changed; everything asked for was already locked."));
    } else {
      for (const line of outcome.diff.lines) log(indent(line));
    }

    if (outcome.answers !== undefined) {
      blankLine();
      subheading("Variables");
      for (const line of formatAskReport(outcome.answers, dryRun)) {
        log(line === "" ? "" : indent(line));
      }
    }

    if (outcome.cycles.length > 0) {
      warning(
        `Some of these recipes co-subscribe to each other in a circle:\n` +
          outcome.cycles.map((cycle) => `  ${cycle.join(" -> ")}`).join("\n") +
          `\nThat is unusual but not broken, and everything above was installed.`
      );
    }

    blankLine();
    log(
      indent(
        dryRun
          ? `Nothing was written. Run the same command without '--dry-run' to install it.`
          : `The subscription to '${outcome.key}' is recorded in this project's config, ` +
              `and the exact versions above are recorded in its lockfile. Run ` +
              `'sous build' to compile what they contribute.`
      )
    );

    footer();
  }
}
