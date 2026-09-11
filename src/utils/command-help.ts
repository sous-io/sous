/**
 * Printing a command's own help underneath an error.
 *
 * A run that failed because a question could not be asked should show the
 * caller every flag that would have answered it, without sending them off to
 * `sous help <command>`. `BaseCommand` does this for every command that
 * discovers a config; the repository authoring commands (`repo init`,
 * `repo release`, `repo submit`) do not extend it, so the mechanism lives here
 * and both callers draw exactly the same screen.
 */

import { loadHelpClass, type Command } from "@oclif/core";

/**
 * Prints one command's help, always to stderr.
 *
 * An error is not output, and a command whose stdout is being piped must not
 * have a help screen spliced into its stream. oclif's help writes to stdout, so
 * stdout is pointed at stderr for the duration and put back afterwards. The help
 * class is the one oclif itself uses for `--help`, `-h` and the `help` command,
 * so all four routes draw the same screen.
 *
 * Drawing the help is a courtesy: a failure to draw it must never replace the
 * error that is actually being reported, so everything here is swallowed.
 *
 * @param command - The command whose help to draw.
 */
export async function printCommandHelpToStderr(command: Command): Promise<void> {
  const writeToStdout = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
    (process.stderr.write as (...args: unknown[]) => boolean)(
      chunk,
      ...rest
    )) as typeof process.stdout.write;

  try {
    const HelpClass = await loadHelpClass(command.config);
    const help = new HelpClass(command.config);
    await help.showHelp([command.id ?? ""]);
  } catch {
    // The help screen is a courtesy; never let it replace the real error.
  } finally {
    process.stdout.write = writeToStdout;
  }
}
