/**
 * `sous repo add <url>`.
 *
 * Adding a repository is the trust ceremony, and the two are deliberately the
 * same act: a repository sous will read from is one written into this project's
 * config, and removing that entry withdraws the trust. Nothing is downloaded
 * before the question is answered, not even the repository's index.
 *
 * Once the answer is yes, exactly one file is fetched: `sous.index.json`. That
 * is all sous needs in order to resolve a ref, list versions and decide what to
 * download later, so adding a repository costs one small request and installs
 * nothing.
 */

import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import { subscriptionServiceFor } from "../../lib/repos/subscription-service.js";
import type { ProviderId } from "../../lib/repos/providers/provider.js";
import {
  blankLine,
  dryRunNotice,
  footer,
  indent,
  heading,
  log,
  showCommandVars,
  showVars,
} from "../../utils/formatting.js";
import { confirmationFlag } from "../../utils/flags.js";

export default class RepoAdd extends BaseCommand {
  static description =
    "Add a recipe repository to this project, which is also how you trust it";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["repos:add"];

  static examples = [
    "<%= config.bin %> repo add https://github.com/sous-io/sous-recipes",
    "<%= config.bin %> repo add https://github.com/sous-io/sous-recipes --name recipes",
    "<%= config.bin %> repo add /home/me/Projects/my-recipes --trust",
    "<%= config.bin %> repo add ../my-recipes --trust",
  ];

  static args = {
    url: Args.string({
      description:
        "Where the repository lives: its URL, or the path of one on this machine",
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    name: Flags.string({
      description:
        "The short name refs will use for it. Defaults to the last segment of the URL",
    }),
    provider: Flags.string({
      description:
        "The provider that handles it, for a host the URL does not give away",
      options: ["github", "gitlab", "local"],
    }),
    // The only question this command asks is the trust question, so the shared
    // confirmation flag answers it; `--trust` stays a spelling of it, because
    // that is the word the ceremony is named after.
    yes: confirmationFlag({ extraAliases: ["trust"] }),
    "dry-run": Flags.boolean({
      description: "Print what would change without trusting or fetching anything",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(RepoAdd);
    const dryRun = flags["dry-run"];

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      Repository: args.url,
      "Dry Run": dryRun,
    });

    // The heading is not followed by a blank line here: the block that comes
    // next opens with one of its own, and the trust ceremony in the middle may
    // print before either of them.
    heading("Adding a repository");

    if (dryRun) {
      dryRunNotice("Nothing will be trusted, written or downloaded.");
      blankLine();
    }

    const service = subscriptionServiceFor({
      configContext: this.configContext,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    const outcome = await service.addRepo({
      url: args.url,
      ...(flags.name === undefined ? {} : { name: flags.name }),
      ...(flags.provider === undefined
        ? {}
        : { provider: flags.provider as ProviderId }),
      trust: flags.yes,
      dryRun,
    });

    blankLine();

    if (outcome.dryRun) {
      log(
        indent(
          `The repository would be added as '${outcome.name}', read through the ` +
            `${outcome.provider} provider, and its index would be fetched.`
        )
      );
      footer();
      return;
    }

    showVars({
      Repository: outcome.name,
      Location: outcome.url,
      Provider: outcome.provider,
      Namespaces:
        outcome.namespaces.length > 0
          ? outcome.namespaces.join(", ")
          : "none; this repository publishes nothing yet",
      Recipes: String(outcome.recipeCount),
    });

    blankLine();
    log(
      indent(
        outcome.alreadyTrusted
          ? `This project already trusted '${outcome.name}', so only its index was ` +
              `refreshed.`
          : `This project now trusts '${outcome.name}'. Nothing from it has been ` +
              `installed; subscribe to something in it with 'sous subscribe ` +
              `<namespace>/<recipe>'.`
      )
    );

    footer();
  }
}
