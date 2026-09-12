/**
 * `sous vars list`.
 *
 * Prints every variable in play: what it is called, which recipe published it,
 * the environment variable that answered it, the value (hidden when the
 * definition says the variable is a secret), and where the value came from.
 */

import path from "node:path";
import { Flags } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import {
  FileDefinitionSource,
  loadLadderContext,
  loadProjectDefinitions,
  printVariableList,
} from "../../lib/vars/index.js";
import { footer, showCommandVars } from "../../utils/formatting.js";

export default class VarsList extends BaseCommand {
  static description = "List every variable this project's recipes define, with its answer";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["var:list"];

  static examples = [
    "<%= config.bin %> vars list",
    "<%= config.bin %> vars list --file ./questions.yaml",
  ];

  static flags = {
    ...BaseCommand.baseFlags,
    file: Flags.string({
      description:
        "Read the variable definitions from a standalone definitions file instead of the project's recipes",
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(VarsList);

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      Definitions: flags.file ?? "the project's subscribed recipes",
    });

    const source =
      flags.file === undefined
        ? loadProjectDefinitions(this.settings, this.configContext.sousDir)
        : new FileDefinitionSource(path.resolve(process.cwd(), flags.file));

    printVariableList(
      await source.load(),
      loadLadderContext({
        sousDir: this.configContext.sousDir,
        settings: this.settings,
        shellEnv: this.shellEnv,
      })
    );

    footer();
  }
}
