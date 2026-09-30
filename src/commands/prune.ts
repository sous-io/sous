import { Flags } from "@oclif/core";
import { BaseCommand } from "../base-command.js";
import { runProjectBuild } from "../lib/build-service.js";
import { showCommandVars } from "../utils/formatting.js";

export default class Prune extends BaseCommand {
  static description = "Remove output files that are no longer in the current config";

  static examples = [
    "<%= config.bin %> prune",
    "<%= config.bin %> prune --dry-run",
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    "dry-run": Flags.boolean({
      description: "Print what would be pruned without deleting",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Prune);

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      "Dry Run": flags["dry-run"],
    });

    // Prune goes through the same build path as everything else, with the
    // compile step switched off: what counts as current depends on the recipes
    // the lockfile pins, so they are restored first, or a recipe missing from
    // the store would have its outputs pruned as if it were gone.
    await runProjectBuild({
      settings: this.settings,
      configContext: this.configContext,
      shellEnv: this.shellEnv,
      heading: "Pruning",
      options: { noCompile: true, dryRun: flags["dry-run"] },
    });
  }
}
