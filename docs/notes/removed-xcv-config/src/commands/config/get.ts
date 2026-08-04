import { Args } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import { loadProfile } from "../../lib/user-settings.js";
import { log } from "../../utils/formatting.js";

export default class ConfigGet extends BaseCommand {
  static description = "Get a Sous configuration value";

  static examples = [
    "<%= config.bin %> config get profile",
    "<%= config.bin %> config get defaultConfigPath",
  ];

  static args = {
    key: Args.string({
      description: "Config key to read",
      required: true,
    }),
  };

  protected get requiresSettings(): boolean {
    return false;
  }

  async run(): Promise<void> {
    const { args } = await this.parse(ConfigGet);

    if (args.key === "profile") {
      log(this.sousConfig.profile);
      return;
    }

    const profile = loadProfile(this.sousConfig.profile);
    const value = (profile as Record<string, unknown>)[args.key];

    if (value === undefined) {
      this.error(`Unknown profile key: '${args.key}'`);
    }

    log(String(value));
  }
}
