import { ConfigCommand } from "../../config-command.js";
import { renderJson } from "../../lib/config-inspect.js";

export default class ConfigShow extends ConfigCommand {
  static description =
    "Print the merged config (all conf.d layers merged, before variable resolution) as JSON";

  static examples = [
    "<%= config.bin %> config show",
    "<%= config.bin %> config show | jq .compilation",
  ];

  static flags = {
    ...ConfigCommand.baseFlags,
  };

  async run(): Promise<void> {
    await this.parse(ConfigShow);

    // this.settings is the merged config as written: every conf.d layer has been
    // deep-merged and the whole thing schema-validated, but no ${var} has been
    // resolved yet. Colorize only for a TTY so piped output stays valid JSON.
    const useColor = Boolean(process.stdout.isTTY);
    process.stdout.write(`${renderJson(this.settings, useColor)}\n`);
  }
}
