/**
 * Bare `sous vars`, and `sous vars <name>`.
 *
 * The canonical commands are `sous vars list` and `sous vars show <name>`; this
 * is the shorthand that keeps working, so it prints the listing with no argument
 * and the detail with one. It is hidden from the command list so `sous --help`
 * names `vars` once, as a topic.
 *
 * The optional argument works because oclif collates leading space-separated
 * words into a command id only while they keep matching a real command:
 * `sous vars show` finds the `vars:show` command, and `sous vars apiUrl` does
 * not, so it lands here with `apiUrl` as the argument. The one consequence is
 * that a variable named `list`, `show` or `ask` cannot be reached this way;
 * `sous vars show list` reaches it.
 */

import path from "node:path";
import { Args, Flags } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import {
  FileDefinitionSource,
  loadLadderContext,
  loadProjectDefinitions,
  printVariableDetail,
  printVariableList,
} from "../../lib/vars/index.js";
import { footer, showCommandVars } from "../../utils/formatting.js";

export default class Vars extends BaseCommand {
  static description = "List every variable this project's recipes define, with its answer";

  /** Hidden so `sous --help` names `vars` once, as a topic. */
  static hidden = true;

  static examples = ["<%= config.bin %> vars", "<%= config.bin %> vars apiUrl"];

  static args = {
    name: Args.string({
      description:
        "A variable's name (or its namespace/recipe.name key) to show in full",
      required: false,
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
    const { args, flags } = await this.parse(Vars);

    showCommandVars({
      Project: this.projectLabel,
      Config: this.configContext.configPath,
      Definitions: flags.file ?? "the project's subscribed recipes",
    });

    const source =
      flags.file === undefined
        ? loadProjectDefinitions(this.settings, this.configContext.sousDir)
        : new FileDefinitionSource(path.resolve(process.cwd(), flags.file));
    const defined = await source.load();

    const context = loadLadderContext({
      sousDir: this.configContext.sousDir,
      settings: this.settings,
      shellEnv: this.shellEnv,
    });

    if (args.name === undefined) printVariableList(defined, context);
    else printVariableDetail(defined, context, args.name);

    footer();
  }
}
