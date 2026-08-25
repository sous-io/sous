import { BaseCommand } from "./base-command.js";
import { headerTo } from "./utils/formatting.js";

/**
 * Base class for the `xcv config *` inspection commands (`show`, `get`).
 *
 * These commands emit machine-readable output (JSON, or a raw scalar) to stdout
 * so `xcv config show | jq` and friends work. The decorative CLI header would
 * otherwise land on stdout during BaseCommand.init() and corrupt that output, so
 * it is routed to stderr here instead. Discovery, env loading, flag parsing and
 * ConfigError rendering are all inherited unchanged from BaseCommand.
 */
export abstract class ConfigCommand extends BaseCommand {
  private static writeStderr(line: string): void {
    process.stderr.write(`${line}\n`);
  }

  protected emitHeader(): void {
    headerTo(ConfigCommand.writeStderr);
  }

  /**
   * Route init()/catch() error rendering to stderr too. Otherwise a discovery or
   * config-load failure (a not-found config, an invalid merged config, or a
   * missing `config get` path) would print the red error block to stdout for the
   * very commands whose contract is clean, machine-readable stdout — corrupting
   * `xcv config show | jq` and any script capturing stdout.
   */
  protected errorSink: (line: string) => void = ConfigCommand.writeStderr;
}
