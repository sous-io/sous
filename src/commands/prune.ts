import { Flags } from "@oclif/core";
import { BaseCommand } from "../base-command.js";
import { BuildService, resolveStateFilePath } from "../lib/build-service.js";
import { footer, heading, showCommandVars } from "../utils/formatting.js";

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

    const stateFilePath = resolveStateFilePath(this.settings, this.configContext);

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      "Dry Run": flags["dry-run"],
    });

    heading("Pruning");

    const buildService = new BuildService();
    await buildService.prune(this.settings, stateFilePath, flags["dry-run"], this.configContext);

    footer();
  }
}
