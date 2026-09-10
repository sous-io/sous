/**
 * `sous subscribe <ref>`.
 *
 * Subscribing is how a recipe enters a project. The ref names a namespace (every
 * recipe in it, including ones published later) or one recipe, with an optional
 * version range:
 *
 *     sous subscribe workflow/task-files
 *     sous subscribe workflow/task-files@^1.2.0
 *     sous subscribe core
 *     sous subscribe my-recipes:workflow/task-files
 *
 * The whole dependency closure is resolved before anything is downloaded. If it
 * reaches a repository this project has not added, sous stops and asks about it
 * by name, showing which recipe requires it; a run with no terminal fails
 * instead, naming the command that grants the trust. Installs are whole or not
 * at all.
 */

import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../base-command.js";
import { subscriptionServiceFor } from "../lib/repos/subscription-service.js";
import { formatAskReport } from "../lib/vars/ask.js";
import { renderTable } from "../lib/vars/display.js";
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
} from "../utils/formatting.js";

export default class Subscribe extends BaseCommand {
  static description =
    "Subscribe this project to a recipe, or to a whole namespace of them";

  static examples = [
    "<%= config.bin %> subscribe workflow/task-files",
    "<%= config.bin %> subscribe workflow/task-files@^1.2.0",
    "<%= config.bin %> subscribe core",
    "<%= config.bin %> subscribe workflow/task-files --always-pull",
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
    trust: Flags.boolean({
      description:
        "Accept trust for every repository this command adds, without being asked",
      default: false,
    }),
    "dry-run": Flags.boolean({
      description: "Print what would be installed without writing or downloading anything",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Subscribe);
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
      trust: flags.trust,
      dryRun,
    });

    blankLine();
    subheading(dryRun ? "What would be installed" : "What was installed");
    blankLine();

    for (const line of renderTable(
      ["Recipe", "Version", "Repository", "Why"],
      outcome.resolved.map((recipe) => [
        recipe.key,
        recipe.version,
        recipe.repo,
        recipe.requestedBy.includes("project")
          ? "you subscribed to it"
          : recipe.kind === "subscribes"
            ? `co-subscribed by ${recipe.requestedBy.join(", ")}`
            : `needed by ${recipe.requestedBy.join(", ")}`,
      ])
    )) {
      log(indent(line));
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
