/**
 * `sous help`, `sous help <command>`, `sous help <topic>`, `sous help <topic> <command>`.
 *
 * The word form of `--help`, and deliberately the same screen: it hands the
 * arguments straight to the help class oclif itself uses for `--help`, so there
 * is exactly one help renderer and no second copy to fall out of date.
 *
 * This exists because `sous help build` is what people type, and without a
 * command by that name oclif answers "command help not found", which reads like
 * sous has no help at all. Adding it here rather than installing
 * `@oclif/plugin-help` keeps the dependency list as it is.
 *
 * It does not extend `BaseCommand`: reading the help must work from anywhere,
 * including a directory with no `.sous/` above it, and `BaseCommand` requires a
 * discoverable config.
 */

import { Args, Command, loadHelpClass } from "@oclif/core";

export default class Help extends Command {
  static description = "Print the help for sous, or for one command or topic";

  static examples = [
    "<%= config.bin %> help",
    "<%= config.bin %> help build",
    "<%= config.bin %> help repo",
    "<%= config.bin %> help repo add",
  ];

  /** A command id is one or more words, so the argument list is open-ended. */
  static strict = false;

  static args = {
    command: Args.string({
      description: "The command or topic to describe, such as 'build' or 'repo add'",
      required: false,
    }),
  };

  async run(): Promise<void> {
    const { argv } = await this.parse(Help);
    const HelpClass = await loadHelpClass(this.config);
    const help = new HelpClass(this.config, this.config.pjson.oclif.helpOptions);
    await help.showHelp(argv as string[]);
  }
}
