/**
 * `sous vars show <name>`.
 *
 * Prints everything about one variable: the question it asks, its documentation
 * and constraints, the recipe that published it, where an answer would be
 * stored, every environment variable name on the resolution ladder, and which
 * rung actually answered.
 */

import path from "node:path";
import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import {
  FileDefinitionSource,
  loadLadderContext,
  loadProjectDefinitions,
  printVariableDetail,
} from "../../lib/vars/index.js";
import { footer, showCommandVars } from "../../utils/formatting.js";

export default class VarsShow extends BaseCommand {
  static description = "Show everything about one variable, including how it was answered";

  /**
   * The other spelling of the topic. It lives under a hidden topic, so it is
   * typable everywhere without ever reaching the top-level listing.
   */
  static aliases = ["var:show"];

  static examples = [
    "<%= config.bin %> vars show apiUrl",
    "<%= config.bin %> vars show workflow/task-files.apiUrl",
  ];

  static args = {
    name: Args.string({
      description: "A variable's name, or its namespace/recipe.name key",
      required: true,
    }),
  };

  static flags = {
    ...BaseCommand.baseFlags,
    file: Flags.string({
      description:
        "Read the variable definitions from a standalone definitions file instead of the project's recipes",
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(VarsShow);

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      Definitions: flags.file ?? "the project's subscribed recipes",
    });

    const source =
      flags.file === undefined
        ? loadProjectDefinitions(this.settings, this.configContext.sousDir)
        : new FileDefinitionSource(path.resolve(process.cwd(), flags.file));

    printVariableDetail(
      await source.load(),
      loadLadderContext({
        sousDir: this.configContext.sousDir,
        settings: this.settings,
        shellEnv: this.shellEnv,
      }),
      args.name,
      { sousDir: this.configContext.sousDir }
    );

    footer();
  }
}
