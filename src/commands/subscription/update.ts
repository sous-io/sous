/**
 * `sous subscription update [ref]`.
 *
 * Moves the lockfile's pins to the newest versions their ranges allow. With no
 * reference it covers every subscription; a reference narrows it to one
 * repository, one namespace or one recipe:
 *
 *     sous subscription update
 *     sous subscription update sous-recipes
 *     sous subscription update workflow
 *     sous subscription update workflow/task-files
 *
 * Every trusted repository's index is fetched fresh first. A pin moves only
 * within the range its subscription (or the recipe depending on it) declares,
 * and dependencies move with the closure. Only the lockfile changes; the
 * subscriptions themselves are never edited. The whole change is printed as a
 * plan and asked about once, and the project is rebuilt afterwards.
 */

import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import { buildProjectOutputs } from "../../lib/build-service.js";
import { ConfigError } from "../../lib/errors.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import { describeUpdateScope } from "../../lib/repos/update-plan.js";
import { formatAskReport } from "../../lib/vars/ask.js";
import { collectProvidedAnswers } from "../../lib/vars/index.js";
import {
  blankLine,
  dryRunNotice,
  footer,
  heading,
  indent,
  log,
  paragraph,
  showCommandVars,
  subheading,
  warning,
} from "../../utils/formatting.js";
import { answerFlags, confirmationFlag } from "../../utils/flags.js";

export default class SubscriptionUpdate extends BaseCommand {
  static description =
    "Move this project's pinned recipe versions to the newest ones their ranges allow";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["subscriptions:update"];

  static examples = [
    "<%= config.bin %> subscription update",
    "<%= config.bin %> subscription update sous-recipes",
    "<%= config.bin %> subscription update workflow/task-files",
    "<%= config.bin %> subscription update --dry-run",
    "<%= config.bin %> subscription update --yes",
  ];

  static args = {
    ref: Args.string({
      description:
        "What to update: a repository, a namespace or a recipe. Leave it out to update everything",
      required: false,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    // One flag answers both questions this command can ask: the plan, and the
    // trust question for a repository a newer version needs.
    yes: confirmationFlag({ extraAliases: ["trust"] }),
    "accept-first": Flags.boolean({
      description:
        "When the reference matches several things, take the first one listed",
      default: false,
    }),
    "dry-run": Flags.boolean({
      description:
        "Print what would change without writing anything or downloading any recipe",
      default: false,
    }),
    "no-build": Flags.boolean({
      description: "Change the lockfile without rebuilding the project",
      default: false,
    }),
    ...answerFlags(),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(SubscriptionUpdate);
    const dryRun = flags["dry-run"];

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      Updating: args.ref ?? "every subscription",
      "Dry Run": dryRun,
    });

    heading("Updating");

    if (dryRun) {
      dryRunNotice(
        "The indexes are fetched so the plan is current; no recipe is downloaded and " +
          "nothing in this project is written."
      );
    }

    const service = subscriptionServiceFor({
      configContext: this.configContext,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    const provided = collectProvidedAnswers({
      ...(flags.answer === undefined ? {} : { answer: flags.answer }),
      ...(flags["answers-file"] === undefined ? {} : { answersFile: flags["answers-file"] }),
    });

    const outcome = await service.update({
      ...(args.ref === undefined ? {} : { ref: args.ref }),
      yes: flags.yes,
      acceptFirst: flags["accept-first"],
      answers: provided,
      dryRun,
    });

    const scope = describeUpdateScope(outcome.scope);

    if (outcome.nothingToUpdate) {
      footer();
      return;
    }

    if (dryRun) {
      paragraph(
        `Nothing was written. Run the same command without '--dry-run' to update ${scope}.`
      );
      footer();
      return;
    }

    blankLine();
    subheading("Lockfile");
    blankLine();
    if (outcome.diff.unchanged) {
      paragraph("Nothing changed.");
    } else {
      for (const line of outcome.diff.lines) log(indent(line));
    }

    if (outcome.trusted.length > 0) {
      blankLine();
      paragraph(
        `Repositories trusted along the way: ${outcome.trusted.join(", ")}. They are ` +
          `now recorded in this project's config, and your colleagues inherit them.`
      );
    }

    if (outcome.answers !== undefined) {
      blankLine();
      subheading("Variables");
      for (const line of formatAskReport(outcome.answers)) {
        log(line === "" ? "" : indent(line));
      }
    }

    if (outcome.cycles.length > 0) {
      warning(
        `Some of these recipes co-subscribe to each other in a circle:\n` +
          outcome.cycles.map((cycle) => `  ${cycle.join(" -> ")}`).join("\n") +
          `\nThat is unusual but not broken, and the lockfile was updated.`
      );
    }

    const rebuilding = !flags["no-build"] && !outcome.diff.unchanged;

    blankLine();
    paragraph(
      `The lockfile now pins the newest versions the ranges allow for ${scope}. ` +
        `This project's subscriptions are exactly as they were.` +
        (rebuilding || outcome.diff.unchanged ? "" : " The project was not rebuilt.")
    );

    footer();

    if (rebuilding) await this.rebuildProject();
  }

  /**
   * Rebuilds the project now that the lockfile has moved, so the outputs match
   * the new versions when this command returns. The config is reloaded first,
   * because a repository trusted along the way was written into a managed layer.
   * A build that fails leaves the update in place, because it is already
   * written; the message says so.
   */
  private async rebuildProject(): Promise<void> {
    await this.reloadDiscoveredConfig();

    heading("Building the project");

    const succeeded = await buildProjectOutputs(this.settings, this.configContext);

    footer();

    if (!succeeded) {
      throw new ConfigError(
        `The lockfile was updated, but the build that followed it failed, so this ` +
          `project's outputs may not match the new versions yet. The update itself is ` +
          `recorded; fix what the build reported above and run 'sous build' again.`
      );
    }
  }
}
