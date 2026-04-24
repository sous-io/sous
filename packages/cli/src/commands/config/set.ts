import { Args } from "@oclif/core";
import { BaseCommand } from "../../base-command.js";
import {
  loadProfile,
  saveProfile,
  saveSousConfig,
  type ProfileConfig,
} from "../../lib/user-settings.js";
import { log } from "../../utils/formatting.js";

export default class ConfigSet extends BaseCommand {
  static description = "Set a Sous configuration value";

  static examples = [
    "<%= config.bin %> config set profile myprofile",
    "<%= config.bin %> config set defaultConfigPath /path/to/sous.config.local.json",
  ];

  static args = {
    key: Args.string({
      description: "Config key to set",
      required: true,
    }),
    value: Args.string({
      description: "Value to assign",
      required: true,
    }),
  };

  protected get requiresSettings(): boolean {
    return false;
  }

  async run(): Promise<void> {
    const { args } = await this.parse(ConfigSet);

    if (args.key === "profile") {
      this.sousConfig.profile = args.value;
      saveSousConfig(this.sousConfig);
      log(`profile → ${args.value}`);
      return;
    }

    // All other keys go to the active profile file
    const profile = loadProfile(this.sousConfig.profile);
    if (!(args.key in profile)) {
      this.error(`Unknown profile key: '${args.key}'. Valid keys: ${Object.keys(profile).join(", ")}`);
    }

    (profile as Record<string, unknown>)[args.key] = args.value;
    saveProfile(this.sousConfig.profile, profile as ProfileConfig);
    log(`${args.key} → ${args.value}`);
  }
}
