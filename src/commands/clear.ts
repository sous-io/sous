import { Flags } from "@oclif/core";
import { confirm } from "@inquirer/prompts";
import fs from "node:fs";
import { BaseCommand } from "../base-command.js";
import { resolveStateFilePath } from "../lib/build-service.js";
import { StateService } from "../lib/state.js";
import { displayError, footer, heading, log, showCommandVars } from "../utils/formatting.js";

export default class Clear extends BaseCommand {
  static description = "Delete all files and directories written by Sous for a project";

  static examples = [
    "<%= config.bin %> clear",
    "<%= config.bin %> clear --force",
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    force: Flags.boolean({
      char: "f",
      description: "Skip confirmation prompt",
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Clear);

    const stateFilePath = resolveStateFilePath(this.settings, this.configContext);

    const stateService = new StateService();
    const state = await stateService.load(stateFilePath);

    if (!state) {
      displayError(
        `No state file found at ${stateFilePath}. Run 'xcv build' first, then 'xcv clear' to recover.`
      );
      this.exit(1);
    }

    showCommandVars({ Project: this.projectLabel, Config: this.configContext.configPath });

    const fileCount = state!.files.length;
    const dirCount = state!.dirs.length;

    if (!flags.force) {
      const confirmed = await confirm({
        message: `Delete ${fileCount} file(s) and ${dirCount} director(ies) for '${this.projectLabel}'?`,
        default: false,
      });
      if (!confirmed) {
        log("Aborted.");
        return;
      }
    }

    heading("Clearing");

    stateService.deleteTrackedFiles(state!.files, state!.dirs);
    for (const entry of state!.files) log(`  ✗ ${entry.dest}`);

    // Delete state file itself
    if (fs.existsSync(stateFilePath)) {
      fs.rmSync(stateFilePath);
      log(`  ✗ ${stateFilePath} (state file)`);
    }

    footer();
  }
}
